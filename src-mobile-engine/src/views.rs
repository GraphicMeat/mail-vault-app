//! Saved views on the phone: desktop's views (core `app_db::views`), kept in the phone's core
//! `app.db` beside the tags and fields (`tags.rs` [`AppDb`]), and run over the phone's own search
//! index (`search.rs`, core `search_index` in `<data>/search.db`) with desktop's request building
//! (core `view_eval`). The index holds what the phone holds: a view on the phone finds only mail
//! inside each account's offline window (what the phone has synced), never the server's whole
//! mailbox.
//!
//! What differs from desktop's daemon (`handlers/views.rs`), and why:
//! - Rows come back from `mobile.db` (`search::join_back`), in the phone's list-row shape, not
//!   from desktop's custody and header cache.
//! - A tag or field condition names messages by `msg_key`. The phone keys a Graph or JMAP message
//!   with no Message-ID as `r:<remote id>` (`tags.rs`); the index spells that message
//!   `u:<folder>:<uid>` with the phone's uid, so such keys are translated through `remote_ids`
//!   before the index sees them (`msg_keys` and `excludeMessages` alike).
//! - The answered flag is the server's (`mobile.db` `answered`, from `\Answered` or JMAP
//!   `$answered`), indexed as desktop's `R`. Graph reports none, so a Graph message is never
//!   answered, as on desktop.
//! - The editor's suggestions read the phone's index, which keeps no display names: a sender is
//!   offered by its address.
//! - No attachment export, no keyword builder, no "hide view mail".
//!
//! # API
//!
//! - `mobile.views.list {}` -> `{views: [{id, name, icon, position, builtin, def}]}`: in order;
//!   desktop's three starters are seeded the first time (core `ensure_starters`, once).
//! - `mobile.views.save {view}` -> `{view}`: makes the view, or edits the one of that id (its
//!   position stays). A name has at most [`MAX_NAME_CHARS`] characters; a view the user made
//!   needs one. A new view beyond [`MAX_FREE_VIEWS`] without Premium is `PREMIUM_REQUIRED`, as
//!   desktop's views page refuses it (the starters count).
//! - `mobile.views.delete {id}` -> `{views}`; `mobile.views.reorder {ids}` -> `{views}` (every
//!   view once, as core requires).
//! - `mobile.views.evaluate {viewId | def, cursor?}` -> `{available, rows, total, cursor}`: list
//!   rows (plus `accountId` and `folder`), newest first across accounts, [`PAGE`] index hits a page;
//!   `cursor` is null at the end. `available: false` (with `reason: "unavailable"`, no rows) when
//!   the phone has no search index this run.
//! - `mobile.views.counts {}` -> `{counts: {viewId: total}}`; `{}` without an index.
//! - `mobile.views.suggestSenders {prefix, accounts?, limit?}` -> `{senders: [{address, name,
//!   count}]}` and `mobile.views.suggestTerms {prefix, accounts?, offset?, limit?}` -> `{terms:
//!   [{term, count}]}`: the editor's typeahead (core `suggest_senders` / `suggest_terms`, as
//!   desktop's `views.suggest_*`), over the accounts named (none: every account); empty without
//!   an index.
//!
//! Threading: on the RPC thread. `app.db` is read first (the definition and the tag and field
//! identities), then `mobile.db` (the accounts, the key translation), then the search lock once per
//! request (one statement), then `mobile.db` again for the rows; no two are ever held at once.

use crate::db::{Engine, Shared};
use crate::rpc::{parse, RpcError};
use mailvault_core::app_db::views::{self as store, View, ViewDef};
use mailvault_core::search_index::{self, query, text::vault_dir_name};
use mailvault_core::view_eval::{self, ViewAccount};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;

/// Index hits a page of a view reads (as `mobile.search.local`).
const PAGE: usize = 50;
/// Longest view name (desktop's field takes 80).
pub(crate) const MAX_NAME_CHARS: usize = 80;
/// Longest icon (a preset name or `emoji:<one emoji>`).
const MAX_ICON_CHARS: usize = 40;
/// How many views a phone without Premium keeps: desktop's `MAX_FREE_VIEWS`.
pub(crate) const MAX_FREE_VIEWS: usize = 3;

fn internal(e: impl ToString) -> RpcError {
    RpcError::Internal(e.to_string())
}

fn listed(shared: &Shared) -> Result<Vec<View>, RpcError> {
    shared
        .app_db
        .with(|c| {
            store::ensure_starters(c)?;
            store::list(c)
        })
        .map_err(internal)
}

pub(crate) fn list(engine: &Engine, _: Value) -> Result<Value, RpcError> {
    Ok(json!({ "views": listed(engine.shared())? }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveParams {
    view: View,
}

/// A view as the phone stores it: checked and trimmed.
pub(crate) fn checked(view: View) -> Result<View, RpcError> {
    let id = view.id.trim().to_string();
    if id.is_empty() || id.chars().count() > 100 {
        return Err(RpcError::Invalid("a view needs an id".into()));
    }
    let name = view.name.trim().to_string();
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(RpcError::Invalid(format!("a view name has at most {MAX_NAME_CHARS} characters")));
    }
    if view.icon.chars().count() > MAX_ICON_CHARS {
        return Err(RpcError::Invalid("icon too long".into()));
    }
    Ok(View { id, name, ..view })
}

pub(crate) fn save(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: SaveParams = parse(params)?;
    let view = checked(p.view)?;
    let shared = engine.shared();
    let premium = crate::premium::active(shared);
    let saved = shared
        .app_db
        .with(|c| {
            store::ensure_starters(c)?;
            let known = store::get(c, &view.id)?.is_some();
            if !known && !premium && store::list(c)?.len() >= MAX_FREE_VIEWS {
                return Ok(Err(RpcError::Premium("PREMIUM_REQUIRED")));
            }
            // Core refuses a view the user made with no name: the person's input, not a fault.
            Ok(store::save(c, &view).map_err(RpcError::Invalid))
        })
        .map_err(internal)??;
    Ok(json!({ "view": saved }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdParams {
    id: String,
}

pub(crate) fn delete(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: IdParams = parse(params)?;
    engine.shared().app_db.with(|c| store::delete(c, &p.id)).map_err(internal)?;
    Ok(json!({ "views": listed(engine.shared())? }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReorderParams {
    ids: Vec<String>,
}

pub(crate) fn reorder(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: ReorderParams = parse(params)?;
    engine.shared().app_db.with(|c| Ok(store::reorder(c, &p.ids))).map_err(internal)?.map_err(RpcError::Invalid)?;
    Ok(json!({ "views": listed(engine.shared())? }))
}

/// Every account on the phone as a view runs over it: its address and the addresses it sends as
/// (its own for "to me" / "not from me"), and its folders by special use (`\Trash`, ...).
fn accounts(engine: &Engine) -> Result<Vec<ViewAccount>, RpcError> {
    engine
        .read(|c| {
            let rows: Vec<(String, String)> = {
                let mut st = c.prepare_cached("SELECT id, email FROM accounts ORDER BY id")?;
                let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;
                rows
            };
            let ids: Vec<String> = rows.iter().map(|(id, _)| id.clone()).collect();
            let own = crate::account_settings::own_addresses(c, &ids);
            let mut st = c.prepare_cached("SELECT path, special_use FROM folders WHERE account_id = ?1 AND special_use IS NOT NULL")?;
            let mut out = Vec::with_capacity(rows.len());
            for (id, email) in rows {
                let mut aliases: Vec<String> = own["aliases"][&id].as_array().map(Vec::as_slice).unwrap_or_default().iter().filter_map(|a| a["address"].as_str().map(str::to_string)).collect();
                if let Some(send_as) = own["sendAsAddresses"][&id].as_str().filter(|s| !s.trim().is_empty()) {
                    aliases.push(send_as.to_string());
                }
                let mut special_use = HashMap::new();
                for found in st.query_map([&id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
                    let (path, use_) = found?;
                    special_use.entry(use_).or_insert(path);
                }
                out.push(ViewAccount { account_id: id, address: email, aliases, known_mailboxes: Vec::new(), special_use });
            }
            Ok(out)
        })
        .map_err(internal)
}

/// The index's spelling of each of `keys` for `account`: a phone `r:<remote id>` key (a Graph or
/// JMAP message with no Message-ID) becomes the index's `u:<folder>:<uid>` of the row holding that
/// remote id (two, when the message is in two folders); a key no row holds is dropped; every other
/// key is the index's already.
fn index_keys(shared: &Shared, account: &str, keys: &[String]) -> Result<Vec<String>, RpcError> {
    if !keys.iter().any(|k| k.starts_with("r:")) {
        return Ok(keys.to_vec());
    }
    shared
        .read(|c| {
            let mut st = c.prepare_cached("SELECT folder, uid FROM remote_ids WHERE account_id = ?1 AND remote_id = ?2")?;
            let mut out = Vec::with_capacity(keys.len());
            for key in keys {
                match key.strip_prefix("r:") {
                    None => out.push(key.clone()),
                    Some(remote) => {
                        for found in st.query_map((account, remote), |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
                            let (folder, uid) = found?;
                            out.push(format!("u:{}:{uid}", vault_dir_name(&folder)));
                        }
                    }
                }
            }
            Ok(out)
        })
        .map_err(internal)
}

/// The view's requests (`view_eval::batches`) with every key in the index's spelling.
fn requests(engine: &Engine, def: &ViewDef, accounts: &[ViewAccount], keys: &HashMap<String, Vec<String>>) -> Result<Vec<query::SearchRequest>, RpcError> {
    let shared = engine.shared();
    let mut index: HashMap<String, Vec<String>> = HashMap::with_capacity(keys.len());
    for (account, list) in keys {
        index.insert(account.clone(), index_keys(shared, account, list)?);
    }
    let now = mailvault_core::clock::now_secs();
    let mut out = Vec::new();
    for (mut request, group) in view_eval::batches(def, accounts, &index, now) {
        // A message kept out by hand is named by its phone key too.
        if request.exclude_keys.iter().any(|k| k.starts_with("r:")) {
            let mut all = Vec::new();
            for account in &group {
                all.extend(index_keys(shared, &account.account_id, &request.exclude_keys)?);
            }
            all.sort();
            all.dedup();
            request.exclude_keys = all;
        }
        out.push(request);
    }
    Ok(out)
}

/// The definition (`viewId` or `def`) and its tag and field identities per account: the `app.db`
/// part of a run, before any other lock.
fn prepared(engine: &Engine, params: &Value, accounts: &[ViewAccount]) -> Result<(ViewDef, HashMap<String, Vec<String>>), RpcError> {
    engine
        .shared()
        .app_db
        .with(|c| {
            // A starter opened before the list was ever asked for is there all the same.
            store::ensure_starters(c)?;
            let def = match view_eval::definition(c, params) {
                Ok(d) => d,
                Err(e) => return Ok(Err(RpcError::Invalid(e))),
            };
            let keys = view_eval::filter_keys(c, &def, accounts)?;
            Ok(Ok((def, keys)))
        })
        .map_err(internal)?
}

/// One index page of `request`; `None` without an index this run.
fn page_of(shared: &Shared, request: &query::SearchRequest) -> Result<Option<query::SearchPage>, RpcError> {
    let guard = search_index::lock(&shared.search.conn);
    let Some(c) = guard.as_ref() else { return Ok(None) };
    query::search(c, request).map(Some).map_err(internal)
}

fn unavailable() -> Value {
    json!({ "available": false, "reason": "unavailable", "rows": [], "total": 0, "cursor": null })
}

pub(crate) fn evaluate(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let shared = engine.shared();
    let accounts = accounts(engine)?;
    let (def, keys) = prepared(engine, &params, &accounts)?;
    let requests = requests(engine, &def, &accounts, &keys)?;
    // Where each request's hits stand: a page takes the newest hits across requests, so each
    // request moves on by the hits of its own the page took.
    let mut offsets: Vec<usize> = params
        .get("cursor")
        .and_then(Value::as_array)
        .map(|o| o.iter().map(|v| v.as_u64().unwrap_or(0) as usize).collect())
        .filter(|o: &Vec<usize>| o.len() == requests.len())
        .unwrap_or_else(|| vec![0; requests.len()]);
    let mut hits: Vec<(usize, query::SearchHit)> = Vec::new();
    let mut totals: Vec<usize> = Vec::with_capacity(requests.len());
    for (i, request) in requests.iter().enumerate() {
        let request = query::SearchRequest { limit: Some(PAGE), offset: offsets[i], ..request.clone() };
        let Some(page) = page_of(shared, &request)? else { return Ok(unavailable()) };
        totals.push(page.total as usize);
        hits.extend(page.hits.into_iter().map(|h| (i, h)));
    }
    hits.sort_by(|(_, a), (_, b)| b.date_utc.cmp(&a.date_utc).then(b.row_id.cmp(&a.row_id)));
    hits.truncate(PAGE);
    for (i, _) in &hits {
        offsets[*i] += 1;
    }
    let more = offsets.iter().zip(&totals).any(|(o, t)| o < t);
    let page: Vec<query::SearchHit> = hits.into_iter().map(|(_, h)| h).collect();
    let folders = crate::search::folder_paths(engine)?;
    let rows = crate::search::join_back(engine, &folders, &page)?;
    let total: usize = totals.iter().sum();
    Ok(json!({ "available": true, "rows": rows, "total": total, "cursor": if more { json!(offsets) } else { Value::Null } }))
}

pub(crate) fn counts(engine: &Engine, _: Value) -> Result<Value, RpcError> {
    let shared = engine.shared();
    let accounts = accounts(engine)?;
    let views = listed(shared)?;
    let mut counts = serde_json::Map::new();
    for view in &views {
        let keys = shared.app_db.with(|c| view_eval::filter_keys(c, &view.def, &accounts)).map_err(internal)?;
        let mut total = 0u64;
        for request in requests(engine, &view.def, &accounts, &keys)? {
            let request = query::SearchRequest { limit: Some(0), ..request };
            match page_of(shared, &request)? {
                Some(page) => total += page.total,
                // Zero would be a claim about the mail: no index, no counts.
                None => return Ok(json!({ "counts": {} })),
            }
        }
        counts.insert(view.id.clone(), json!(total));
    }
    Ok(json!({ "counts": counts }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SuggestParams {
    #[serde(default)]
    prefix: String,
    #[serde(default)]
    accounts: Vec<String>,
    #[serde(default)]
    offset: usize,
    limit: Option<usize>,
}

pub(crate) fn suggest_senders(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: SuggestParams = parse(params)?;
    let guard = search_index::lock(&engine.shared().search.conn);
    let Some(c) = guard.as_ref() else { return Ok(json!({ "senders": [] })) };
    let found = query::suggest_senders(c, &p.accounts, &p.prefix, p.limit.unwrap_or(8).min(50)).map_err(internal)?;
    Ok(json!({ "senders": found }))
}

pub(crate) fn suggest_terms(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: SuggestParams = parse(params)?;
    let guard = search_index::lock(&engine.shared().search.conn);
    let Some(c) = guard.as_ref() else { return Ok(json!({ "terms": [] })) };
    let found = query::suggest_terms(c, &p.accounts, &p.prefix, p.offset, p.limit.unwrap_or(20).min(50)).map_err(internal)?;
    Ok(json!({ "terms": found }))
}
