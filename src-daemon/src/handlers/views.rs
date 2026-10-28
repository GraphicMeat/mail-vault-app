//! Saved-view RPCs.
//!
//! A view is a stored set of filters, evaluated here and never in the app: a
//! set difference against a partly loaded list is not a view, it is a guess.
//! The definition lives in `app.db`; the rows come from the search index, in
//! the same shape `mail_search` returns, so the list renders them unchanged.
use crate::handlers::common::{blocking, done};
use crate::handlers::vault_files::ExportJob;
use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use mailvault_core::app_db;
use serde_json::Value;
use std::sync::Arc;

use app_db::views::{self, View, ViewDef};
use mailvault_core::search_index::query::SearchRequest;
use std::collections::HashMap;

/// One account the view runs over, as the app already knows it.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    account_id: String,
    /// The account's own address, for "addressed to me" / "not from me".
    #[serde(default)]
    address: String,
    /// Its other own addresses (default From, aliases), which count for
    /// "addressed to me" / "not from me" as the login does.
    #[serde(default)]
    aliases: Vec<String>,
    /// Server paths, so a row can name the mailbox it came from rather than
    /// the vault directory it is stored in.
    #[serde(default)]
    known_mailboxes: Vec<String>,
    /// IMAP special-use attribute to server path, for this account. A folder
    /// name is a per-mailbox word, so "not the bin" is only answerable here.
    #[serde(default)]
    special_use: HashMap<String, String>,
}

/// One message a search put on screen.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Message {
    account_id: String,
    mailbox: String,
    uid: u32,
}

fn json_of<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

fn accounts_of(params: &Value) -> Result<Vec<Account>, String> {
    serde_json::from_value(params.get("accounts").cloned().unwrap_or(Value::Null)).map_err(|e| format!("accounts: {e}"))
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    if !method.starts_with("views.") {
        return None;
    }
    let state = Arc::clone(state);
    let params = params.clone();
    if method == "views.export_attachments" {
        let Some(job_id) = params.get("jobId").and_then(Value::as_str).map(str::to_owned) else {
            return Some(done(id, Err("Missing jobId".to_string())));
        };
        if params.get("destDir").and_then(Value::as_str).is_none_or(str::is_empty) {
            return Some(done(id, Err("Missing destDir".to_string())));
        }
        // A job (`vault_files::ExportJob`): answered at once, reported in frames.
        let mut job = ExportJob::new(&state, job_id.clone(), 0);
        tokio::spawn(async move {
            let _ = blocking(move || {
                let result = export_attachments(&state, &params, &mut job);
                job.finish(result);
            })
            .await;
        });
        return Some(done(id, Ok(serde_json::json!({ "jobId": job_id }))));
    }
    let method = method.to_string();
    Some(done(id, blocking(move || run(&state, &method, &params)).await.and_then(|r| r)))
}

/// Every real attachment the view finds, flat in one folder the person
/// picked. The app narrows the definition first when a person picked one
/// month or year out of the range; `hasAttachments` is forced here so a view
/// without it cannot walk every message in the vault. A search is not a view
/// (its targets span folders and servers a definition cannot name), so it
/// hands over the rows on screen as `messages`. Progress is counted in
/// messages: how many files a view holds is unknown until each is parsed.
fn export_attachments(state: &Arc<DaemonState>, params: &Value, job: &mut ExportJob) -> Result<Value, String> {
    let app_dir = state.app_dir.as_path();
    let dest_dir = params.get("destDir").and_then(Value::as_str).filter(|d| !d.is_empty()).ok_or("Missing destDir")?;
    let messages = match params.get("messages") {
        Some(list) => serde_json::from_value::<Vec<Message>>(list.clone())
            .map_err(|e| format!("messages: {e}"))?
            .into_iter()
            .map(|m| (m.account_id, m.mailbox, m.uid))
            .collect(),
        None => {
            let accounts = accounts_of(params)?;
            let (mut def, keys) = app_db::with(app_dir, |conn| {
                let def = definition(conn, params)?;
                Ok((def.clone(), filter_keys(conn, &def, &accounts)?))
            })?;
            def.has_attachments = true;
            messages_of(state, &def, &accounts, &keys)?
        }
    };
    // An unreachable vault fails the export whole, as before; a message it
    // has no copy of comes from the server (`raw_message`).
    crate::handlers::common::vault_root(state)?;
    // Called on a blocking thread (`route`), so it may wait here.
    let handle = tokio::runtime::Handle::current();
    let total = messages.len();
    json_of(mailvault_core::vault_files::export_many_attachments(
        &messages,
        std::path::Path::new(dest_dir),
        &mut |account_id, mailbox, uid| handle.block_on(crate::raw_message::raw_message(state, account_id, mailbox, uid, true)).map(|raw| raw.to_vec()),
        &mut |done| job.step(done, total, None),
    )?)
}

fn run(state: &Arc<DaemonState>, method: &str, params: &Value) -> Result<Value, String> {
    let app_dir = state.app_dir.as_path();
    match method {
        "views.list" => app_db::with(app_dir, |conn| {
            views::ensure_starters(conn)?;
            json_of(views::list(conn)?)
        }),
        "views.save" => {
            let view: View =
                serde_json::from_value(params.get("view").cloned().unwrap_or(Value::Null)).map_err(|e| format!("view: {e}"))?;
            app_db::with(app_dir, |conn| json_of(views::save(conn, &view)?))
        }
        "views.delete" => {
            let id = params.get("id").and_then(Value::as_str).ok_or("Missing id")?.to_string();
            app_db::with(app_dir, |conn| views::delete(conn, &id).map(|_| Value::Null))
        }
        "views.reorder" => {
            let ids: Vec<String> = serde_json::from_value(params.get("ids").cloned().unwrap_or(Value::Null))
                .map_err(|e| format!("ids: {e}"))?;
            app_db::with(app_dir, |conn| views::reorder(conn, &ids).map(|_| Value::Null))
        }
        "views.evaluate" => {
            let accounts = accounts_of(params)?;
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(500) as usize;
            // Every app.db read happens here, before the index lock is taken.
            let (def, keys) = app_db::with(app_dir, |conn| {
                let def = definition(conn, params)?;
                Ok((def.clone(), filter_keys(conn, &def, &accounts)?))
            })?;
            evaluate(state, &def, &accounts, &keys, limit)
        }
        // Who sends what the view's words find, for the builder's "keep these
        // out" suggestions: `{ available, senders: [{ address, name, count,
        // own }] }`. The view's own sender rules are left off, so a sender it
        // blocks stays on the list to be allowed again.
        "views.senders" => {
            let accounts = accounts_of(params)?;
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(30).min(100) as usize;
            let (def, keys) = app_db::with(app_dir, |conn| {
                let def = definition(conn, params)?;
                Ok((def.clone(), filter_keys(conn, &def, &accounts)?))
            })?;
            senders(state, &def, &accounts, &keys, limit)
        }
        "views.counts" => {
            let accounts = accounts_of(params)?;
            let (all, keys) = app_db::with(app_dir, |conn| {
                views::ensure_starters(conn)?;
                let all = views::list(conn)?;
                let mut keys = HashMap::new();
                for view in &all {
                    keys.insert(view.id.clone(), filter_keys(conn, &view.def, &accounts)?);
                }
                Ok((all, keys))
            })?;
            let mut counts = serde_json::Map::new();
            for view in &all {
                let empty = HashMap::new();
                let per_view = keys.get(&view.id).unwrap_or(&empty);
                let reply = evaluate(state, &view.def, &accounts, per_view, 0)?;
                // Zero is a claim about the mail. An index that cannot answer
                // has not made it, so the whole reply is empty rather than a
                // column of confident noughts.
                if reply.get("available").and_then(Value::as_bool) != Some(true) {
                    return Ok(Value::Object(serde_json::Map::new()));
                }
                counts.insert(view.id.clone(), reply.get("total").and_then(Value::as_u64).unwrap_or(0).into());
            }
            Ok(Value::Object(counts))
        }
        // Every message any saved view finds, per account and mailbox, for
        // the list that hides view mail. Background work: not foreground.
        // `viewIds` narrows it to the views the person picked; absent is all.
        "views.hidden_members" => {
            let accounts = accounts_of(params)?;
            let picked: Option<Vec<String>> = params
                .get("viewIds")
                .map(|ids| serde_json::from_value(ids.clone()).map_err(|e| format!("viewIds: {e}")))
                .transpose()?;
            let (all, keys) = app_db::with(app_dir, |conn| {
                views::ensure_starters(conn)?;
                let mut all = views::list(conn)?;
                if let Some(picked) = &picked {
                    all.retain(|view| picked.contains(&view.id));
                }
                let mut keys = HashMap::new();
                for view in &all {
                    keys.insert(view.id.clone(), filter_keys(conn, &view.def, &accounts)?);
                }
                Ok((all, keys))
            })?;
            hidden_members(state, &all, &accounts, &keys)
        }
        // The reader pane's view builder: the open message's distinctive
        // words. Foreground: a person is looking at the message.
        "views.keywords" => keywords(state, params),
        // The senders and subjects behind one of those words, on hover.
        "views.keyword_detail" => keyword_detail(state, params),
        // The editor's sender typeahead: `[{ address, name, count }]`, from
        // the same index the view runs on. No accounts named is every account.
        "views.suggest_senders" => {
            let prefix = params.get("prefix").and_then(Value::as_str).unwrap_or("");
            let accounts: Vec<String> = serde_json::from_value(params.get("accounts").cloned().unwrap_or(Value::Null))
                .unwrap_or_default();
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(8).min(50) as usize;
            json_of(crate::search_index::suggest_senders(&state.search_index, &accounts, prefix, limit)?)
        }
        // The editor's query-field typeahead: `[{ term, count }]`, 20 per
        // page by default. No accounts named is every account.
        "views.suggest_terms" => {
            let prefix = params.get("prefix").and_then(Value::as_str).unwrap_or("");
            let accounts: Vec<String> = serde_json::from_value(params.get("accounts").cloned().unwrap_or(Value::Null))
                .unwrap_or_default();
            let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(20).min(50) as usize;
            json_of(crate::search_index::suggest_terms(&state.search_index, &accounts, prefix, offset, limit)?)
        }
        _ => Err(format!("Unknown method: {method}")),
    }
}

/// Candidate words of a message probed against the index.
const KEYWORD_CANDIDATES: usize = 150;
/// Ranked words a `views.keywords` reply holds.
const KEYWORDS_KEPT: usize = 15;
/// Reference numbers and street addresses it holds, each.
const KEYWORD_IDENTIFIERS_KEPT: usize = 6;
const KEYWORD_PHRASES_KEPT: usize = 6;
/// Candidate words read from attachment text.
const KEYWORD_ATTACHMENT_CANDIDATES: usize = 60;
/// `views.keywords` replies kept, most recently used last.
const KEYWORD_CACHE_CAP: usize = 64;
/// Hits a `views.keyword_detail` aggregates (the index's per-query cap).
const DETAIL_HITS: usize = 2000;
/// Senders and subjects a `views.keyword_detail` reply names.
const DETAIL_TOP: usize = 10;

/// Recent `views.keywords` replies. Reopening a message asks again, and its
/// answer is a read of the message plus up to 150 index probes that move only
/// as the mailbox grows.
fn keyword_cache() -> &'static std::sync::Mutex<std::collections::VecDeque<(String, Value)>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::VecDeque<(String, Value)>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn cached_keywords(key: &str) -> Option<Value> {
    let mut cache = keyword_cache().lock().unwrap_or_else(|p| p.into_inner());
    let at = cache.iter().position(|(k, _)| k == key)?;
    let entry = cache.remove(at)?;
    let reply = entry.1.clone();
    cache.push_back(entry);
    Some(reply)
}

fn cache_keywords(key: String, reply: Value) {
    let mut cache = keyword_cache().lock().unwrap_or_else(|p| p.into_inner());
    cache.retain(|(k, _)| *k != key);
    cache.push_back((key, reply));
    while cache.len() > KEYWORD_CACHE_CAP {
        cache.pop_front();
    }
}

/// `{ available, keywords: [{ term, tf, df, kind, source }] }`: the open
/// message's most distinctive terms. `kind` is `identifier` (a reference
/// number, at most 6), `phrase` (a street address, at most 6) or `word` (at
/// most 15), each kind best first, in that order. `source` is `body` or
/// `attachment`; attachment text is read only with `withAttachments`. The
/// words: The text is what the index
/// itself stores for the message (subject and stripped body); each word's
/// document frequency is one index probe, the lock released between probes
/// so a click never waits behind the whole list, and each probe stops
/// counting where the "too common" cut would drop the word anyway. An index
/// that cannot answer (off, closed, still building) is `available: false`
/// with no words, cached or not.
fn keywords(state: &Arc<DaemonState>, params: &Value) -> Result<Value, String> {
    use mailvault_core::search_index::keywords::{candidates, df_cap, identifiers, phrases, rank};
    let account_id = params.get("accountId").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("Missing accountId")?;
    let mailbox = params.get("mailbox").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("Missing mailbox")?;
    let uid = params.get("uid").and_then(Value::as_u64).and_then(|uid| u32::try_from(uid).ok()).ok_or("Missing uid")?;
    // Attachment text is read only when asked for: the first answer must not
    // wait on a PDF.
    let with_attachments = params.get("withAttachments").and_then(Value::as_bool).unwrap_or(false);
    let unavailable = || serde_json::json!({ "available": false, "keywords": [] });
    let index = &state.search_index;
    // The readiness gate comes before the cache: an index switched off or
    // rebuilding answers nothing, whatever it said earlier.
    let Ok(row) = crate::search_index::indexed_message(index, account_id, mailbox, uid)? else {
        return Ok(unavailable());
    };
    // A message whose body the index holds has every word of it counted at
    // least once, so a word the index never saw is noise. One not indexed
    // yet keeps such words: the mailbox has simply not read it.
    let body_indexed = row.as_ref().is_some_and(|row| row.body_indexed);
    // Every answer is kept, an unread body's too: stepping through a folder
    // the indexer has not reached (or an On Demand one) would otherwise read,
    // maybe fetch, the message and probe the index again on every keypress.
    // What the index holds of the message is in the key (no row, body not
    // read, body indexed), so the indexer reaching it changes the key and
    // the answer is worked out again. The Message-ID tells a uid reused
    // after a mailbox reset from the message it used to name (for a message
    // the index has no row for, the header cache's), and the data dir keeps
    // two daemon states (tests) apart. No Message-ID anywhere: not cached.
    let held = match &row {
        None => "none",
        Some(_) if body_indexed => "body",
        Some(_) => "listed",
    };
    let message_id = match &row {
        Some(row) => row.message_id.clone(),
        None => listed_message_id(state, account_id, mailbox, uid),
    };
    let key = message_id
        .filter(|id| !id.is_empty())
        .map(|id| format!("{}|{account_id}|{mailbox}|{uid}|{id}|{held}|{with_attachments}", state.data_dir.display()));
    if let Some(reply) = key.as_deref().and_then(cached_keywords) {
        return Ok(reply);
    }
    let Ok(total) = crate::search_index::total_docs(index)? else { return Ok(unavailable()) };
    // Called on a blocking thread (`route`), so it may wait here.
    let raw = tokio::runtime::Handle::current()
        .block_on(crate::raw_message::raw_message(state, account_id, mailbox, uid, true))?;
    let doc = crate::search_index::index_doc_from_light(&raw, uid, "")
        .ok_or_else(|| format!("Email UID {uid} could not be parsed"))?;
    let att_text = if with_attachments { crate::search_index::attachment_texts(&raw).join("\n") } else { String::new() };
    let body_text = format!("{}\n{}", doc.subject, doc.body_text);
    let cap = df_cap(total);
    let gone = std::cell::Cell::new(false);
    // A word the index never saw is noise only when the whole message came
    // from the index's own reading of it: attachment text is not indexed.
    let drop_unseen = body_indexed && att_text.is_empty();
    let rank_kind = |cands: Vec<(String, u32)>, keep: usize| {
        rank(
            cands,
            total,
            |term| {
                // A person is waiting on every probe: the indexer stays parked
                // for the whole loop, not just its first lock hold.
                crate::search_index::note_foreground(index);
                match crate::search_index::term_doc_count(index, term, cap)? {
                    Ok(df) => Ok(df),
                    Err(reason) => {
                        gone.set(true);
                        Err(reason.to_string())
                    }
                }
            },
            keep,
            drop_unseen,
        )
    };
    let mut keywords: Vec<Value> = Vec::new();
    for (kind, keep, from_body, from_att) in [
        (
            "identifier",
            KEYWORD_IDENTIFIERS_KEPT,
            identifiers(&body_text, KEYWORD_CANDIDATES),
            identifiers(&att_text, KEYWORD_CANDIDATES),
        ),
        (
            "phrase",
            KEYWORD_PHRASES_KEPT,
            phrases(&body_text, KEYWORD_CANDIDATES),
            phrases(&att_text, KEYWORD_CANDIDATES),
        ),
        (
            "word",
            KEYWORDS_KEPT,
            candidates(&doc.subject, &doc.body_text, KEYWORD_CANDIDATES),
            candidates("", &att_text, KEYWORD_ATTACHMENT_CANDIDATES),
        ),
    ] {
        // Body first; a term in both counts once, at both counts, from the body.
        let mut merged: Vec<(String, u32)> = from_body;
        let mut source: HashMap<String, &str> = merged.iter().map(|(t, _)| (t.to_lowercase(), "body")).collect();
        for (term, tf) in from_att {
            match merged.iter_mut().find(|(t, _)| t.to_lowercase() == term.to_lowercase()) {
                Some(known) => known.1 = known.1.saturating_add(tf),
                None => {
                    source.insert(term.to_lowercase(), "attachment");
                    merged.push((term, tf));
                }
            }
        }
        let ranked = rank_kind(merged, keep);
        // The index went away between probes: unknown, not "no keywords".
        if gone.get() {
            return Ok(unavailable());
        }
        for k in ranked? {
            let from = source.get(&k.term.to_lowercase()).copied().unwrap_or("body");
            keywords.push(serde_json::json!({ "term": k.term, "tf": k.tf, "df": k.df, "kind": kind, "source": from }));
        }
    }
    let reply = serde_json::json!({ "available": true, "keywords": keywords });
    if let Some(key) = key {
        cache_keywords(key, reply.clone());
    }
    Ok(reply)
}

/// The Message-ID the header cache lists for `uid`, if it lists one (the
/// check `raw_message` makes of a copy it did not read from the vault). A
/// store that cannot be read names none.
fn listed_message_id(state: &DaemonState, account_id: &str, mailbox: &str, uid: u32) -> Option<String> {
    let rows = crate::custody::with_conn(state, |conn| {
        mailvault_core::custody::cache::load_by_uids(conn, account_id, mailbox, &[uid])
    })
    .ok()?;
    let row = rows.into_iter().next()?;
    row.get("messageId").or_else(|| row.get("message_id")).and_then(Value::as_str).map(str::to_string)
}

/// A subject without its reply and forward prefixes (`Re: Fwd: re:`).
fn base_subject(subject: &str) -> &str {
    let mut rest = subject.trim();
    loop {
        let Some(colon) = rest.find(':').filter(|&at| at <= 4) else { return rest };
        if !matches!(rest[..colon].trim().to_ascii_lowercase().as_str(), "re" | "fw" | "fwd") {
            return rest;
        }
        rest = rest[colon + 1..].trim_start();
    }
}

/// The key with the highest count; equal counts go to the smallest key.
fn most_frequent(counts: &std::collections::BTreeMap<String, u64>) -> Option<&String> {
    counts.iter().fold(None, |best: Option<(&String, u64)>, (key, &n)| match best {
        Some((_, top)) if top >= n => best,
        _ => Some((key, n)),
    })
    .map(|(key, _)| key)
}

/// `accounts` as account ids: plain strings, or objects carrying `accountId`
/// (the shape `views.evaluate` takes).
fn account_ids_of(params: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for entry in params.get("accounts").and_then(Value::as_array).into_iter().flatten() {
        let id = entry.as_str().or_else(|| entry.get("accountId").and_then(Value::as_str)).unwrap_or("");
        if !id.is_empty() && !out.iter().any(|known| known == id) {
            out.push(id.to_string());
        }
    }
    out
}

/// `{ available, total, senders: [{ name, address, count }], subjects:
/// [{ subject, sender, count }] }` for the messages a search for `term`
/// finds across `accounts` (`total` is every match; the lists are read from
/// the first 2000, the index's per-query cap). Senders group by lowercased
/// address; subjects by their text without `Re:`/`Fwd:`, case aside, each
/// naming its most frequent sender. Ten of each, most first; equal counts in
/// key order. No accounts named is every account.
fn keyword_detail(state: &DaemonState, params: &Value) -> Result<Value, String> {
    use std::collections::{BTreeMap, HashMap};
    let term = params.get("term").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()).ok_or("Missing term")?;
    let reply = |available: bool, total: u64, senders: Vec<Value>, subjects: Vec<Value>| {
        serde_json::json!({ "available": available, "total": total, "senders": senders, "subjects": subjects })
    };
    let mut account_ids = account_ids_of(params);
    // No accounts named is every account, as in the editor's typeaheads.
    if account_ids.is_empty() {
        account_ids = match crate::search_index::indexed_accounts(&state.search_index)? {
            Ok(all) => all,
            Err(_) => return Ok(reply(false, 0, Vec::new(), Vec::new())),
        };
        if account_ids.is_empty() {
            return Ok(reply(true, 0, Vec::new(), Vec::new()));
        }
    }
    let request = SearchRequest { account_ids, query: term.to_string(), limit: Some(DETAIL_HITS), ..Default::default() };
    let page = match crate::search_index::search_page(&state.search_index, &request)? {
        Ok(page) => page,
        Err(_) => return Ok(reply(false, 0, Vec::new(), Vec::new())),
    };
    // address -> (count, name -> count)
    let mut senders: HashMap<String, (u64, BTreeMap<String, u64>)> = HashMap::new();
    // subject key -> (shown text, count, address -> count)
    let mut subjects: HashMap<String, (String, u64, BTreeMap<String, u64>)> = HashMap::new();
    for hit in &page.hits {
        let row: Value = serde_json::from_str(&hit.row_json).unwrap_or(Value::Null);
        let address = row.pointer("/from/address").and_then(Value::as_str).unwrap_or("").trim().to_lowercase();
        let name = row.pointer("/from/name").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if !address.is_empty() {
            let entry = senders.entry(address.clone()).or_default();
            entry.0 += 1;
            if !name.is_empty() {
                *entry.1.entry(name).or_default() += 1;
            }
        }
        let subject = base_subject(row.get("subject").and_then(Value::as_str).unwrap_or(""));
        if !subject.is_empty() {
            let entry = subjects.entry(subject.to_lowercase()).or_insert_with(|| (subject.to_string(), 0, BTreeMap::new()));
            entry.1 += 1;
            if !address.is_empty() {
                *entry.2.entry(address).or_default() += 1;
            }
        }
    }
    let shown_sender = |address: &str| -> String {
        senders.get(address).and_then(|(_, names)| most_frequent(names)).cloned().unwrap_or_else(|| address.to_string())
    };
    let mut top_senders: Vec<(&String, &(u64, BTreeMap<String, u64>))> = senders.iter().collect();
    top_senders.sort_by(|a, b| b.1 .0.cmp(&a.1 .0).then_with(|| a.0.cmp(b.0)));
    let sender_rows: Vec<Value> = top_senders
        .into_iter()
        .take(DETAIL_TOP)
        .map(|(address, (count, names))| {
            serde_json::json!({ "name": most_frequent(names).cloned().unwrap_or_default(), "address": address, "count": count })
        })
        .collect();
    let mut top_subjects: Vec<(&String, &(String, u64, BTreeMap<String, u64>))> = subjects.iter().collect();
    top_subjects.sort_by(|a, b| b.1 .1.cmp(&a.1 .1).then_with(|| a.0.cmp(b.0)));
    let subject_rows: Vec<Value> = top_subjects
        .into_iter()
        .take(DETAIL_TOP)
        .map(|(_, (shown, count, by))| {
            let sender = most_frequent(by).map(|address| shown_sender(address)).unwrap_or_default();
            serde_json::json!({ "subject": shown, "sender": sender, "count": count })
        })
        .collect();
    Ok(reply(true, page.total, sender_rows, subject_rows))
}

/// The definition to run: a saved view by id, or one handed over inline (which
/// is how "save this search as a view" previews before it is saved).
fn definition(conn: &app_db::Connection, params: &Value) -> Result<ViewDef, String> {
    if let Some(id) = params.get("viewId").and_then(Value::as_str) {
        return views::get(conn, id)?.map(|view| view.def).ok_or_else(|| format!("no such view: {id}"));
    }
    serde_json::from_value(params.get("def").cloned().unwrap_or(Value::Null)).map_err(|e| format!("def: {e}"))
}

/// Per account, the identities that satisfy every tag and every field
/// condition the view names. Absent when the view narrows on neither — which
/// is not the same as an empty list, and the difference is "show everything"
/// against "show nothing".
fn filter_keys(
    conn: &app_db::Connection,
    def: &ViewDef,
    accounts: &[Account],
) -> Result<HashMap<String, Vec<String>>, String> {
    let mut keys = HashMap::new();
    if !narrows_by_metadata(def) {
        return Ok(keys);
    }
    for account in accounts {
        let mut allowed: Option<std::collections::BTreeSet<String>> = None;
        if !def.tags.is_empty() {
            let carried = app_db::tags::messages_with_every_tag(conn, &account.account_id, &def.tags)?;
            allowed = Some(carried.into_iter().collect());
        }
        for filter in &def.fields {
            let matched: std::collections::BTreeSet<String> =
                app_db::fields::messages_matching(conn, &account.account_id, filter)?.into_iter().collect();
            allowed = Some(match allowed {
                Some(existing) => existing.intersection(&matched).cloned().collect(),
                None => matched,
            });
        }
        keys.insert(account.account_id.clone(), allowed.unwrap_or_default().into_iter().collect());
    }
    Ok(keys)
}

/// Whether the view narrows on anything `app.db` holds rather than the index.
fn narrows_by_metadata(def: &ViewDef) -> bool {
    !def.tags.is_empty() || !def.fields.is_empty()
}

/// The login and every alias, lowercased, deduped, blanks dropped.
fn own_addresses(account: &Account) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in std::iter::once(&account.address).chain(account.aliases.iter()) {
        let address = raw.trim().to_lowercase();
        if !address.is_empty() && !out.contains(&address) {
            out.push(address);
        }
    }
    out
}

fn request_for(def: &ViewDef, account: &Account, keys: &HashMap<String, Vec<String>>, now: i64) -> SearchRequest {
    let own = own_addresses(account);
    let (date_from, date_to) = views::date_window(def, now);
    SearchRequest {
        account_id: account.account_id.clone(),
        account_ids: Vec::new(),
        query: def.query.clone(),
        mailboxes: (!def.mailboxes.is_empty()).then(|| def.mailboxes.clone()),
        mailboxes_excluded: def
            .mailboxes_excluded
            .iter()
            .cloned()
            .chain(def.exclude_special.iter().filter_map(|use_| account.special_use.get(use_).cloned()))
            .collect(),
        sender: def.sender.clone(),
        // "The last N days" and "last month" are resolved now, not when the
        // view was saved.
        date_from,
        date_to,
        has_attachments: def.has_attachments,
        unread: def.unread,
        starred: def.starred,
        answered: def.answered,
        to_any: if def.to_me { own.clone() } else { Vec::new() },
        from_none: if def.not_from_me { own } else { Vec::new() },
        from_any: def.senders.clone(),
        from_not: def.exclude_senders.clone(),
        exclude_keys: def.exclude_messages.clone(),
        exclude_terms: Vec::new(),
        // A tag or field filter with no identities behind it matches nothing,
        // which is the correct answer for a tag nobody has used.
        msg_keys: narrows_by_metadata(def).then(|| keys.get(&account.account_id).cloned().unwrap_or_default()),
        limit: None,
        offset: 0,
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Every message a view finds as `(account, mailbox, uid)`, walked page by
/// page past the index's per-query cap. The index lock is taken per page and
/// released before any file is read.
fn messages_of(
    state: &DaemonState,
    def: &ViewDef,
    accounts: &[Account],
    keys: &HashMap<String, Vec<String>>,
) -> Result<Vec<(String, String, u32)>, String> {
    use mailvault_core::search_index::query::MAX_LIMIT;
    let now = now_secs();
    let mut out = Vec::new();
    // Mail indexed mid-walk shifts later pages by a row; the same message
    // twice would land as `photo.png` and `photo (1).png`.
    let mut seen = std::collections::HashSet::new();
    for account in accounts.iter().filter(|account| def.accounts.is_empty() || def.accounts.contains(&account.account_id)) {
        let mut request = SearchRequest { limit: Some(MAX_LIMIT), ..request_for(def, account, keys, now) };
        loop {
            let page = crate::search_index::search_page_reply(&state.search_index, &request)?
                .map_err(|reason| format!("search index unavailable: {reason}"))?
                .page;
            for hit in &page.hits {
                let (mailbox, local_only, _) =
                    crate::handlers::mail_search::mailbox_for_vault_dir(&hit.vault_dir, &account.known_mailboxes);
                let mailbox = if local_only { hit.vault_dir.clone() } else { mailbox };
                let message = (account.account_id.clone(), mailbox, hit.uid);
                if seen.insert(message.clone()) {
                    out.push(message);
                }
            }
            if page.hits.len() < MAX_LIMIT {
                break;
            }
            request.offset += page.hits.len();
        }
    }
    Ok(out)
}

/// Uids per custody lock hold in `hidden_members`.
const HIDDEN_MEMBERS_UNIT: usize = 900;

/// `{ available, members: { account: { mailbox: { uids, unread } } } }`: the
/// union of every view's messages, narrowed to the uids the header cache
/// lists (what the mail list shows), with `unread` counted from the cached
/// server flags. A mailbox the account does not know (a local-only folder)
/// is never hidden. An index or custody store that cannot answer is
/// `available: false` with no members, which the app reads as "hide nothing";
/// an empty `members` with `available: true` is a real "nothing to hide".
fn hidden_members(
    state: &DaemonState,
    all: &[View],
    accounts: &[Account],
    keys: &HashMap<String, HashMap<String, Vec<String>>>,
) -> Result<Value, String> {
    use std::collections::{BTreeMap, BTreeSet};
    let unavailable = || serde_json::json!({ "available": false, "members": {} });
    let now = now_secs();
    let mut found: BTreeMap<String, BTreeMap<String, BTreeSet<u32>>> = BTreeMap::new();
    let empty = HashMap::new();
    for view in all {
        let per_view = keys.get(&view.id).unwrap_or(&empty);
        for account in accounts.iter().filter(|account| view.def.accounts.is_empty() || view.def.accounts.contains(&account.account_id)) {
            // Keys only, uncapped, one index lock hold per (view, account):
            // no row JSON, no snippet, no page walk.
            let request = request_for(&view.def, account, per_view, now);
            let hits = match crate::search_index::member_keys(&state.search_index, &request)? {
                Ok(hits) => hits,
                Err(_) => return Ok(unavailable()),
            };
            for (_, vault_dir, uid) in hits {
                let (mailbox, local_only, _) =
                    crate::handlers::mail_search::mailbox_for_vault_dir(&vault_dir, &account.known_mailboxes);
                // A local-only (or ambiguous) folder is not on the list it
                // would be hidden from.
                if local_only {
                    continue;
                }
                found.entry(account.account_id.clone()).or_default().entry(mailbox).or_default().insert(uid);
            }
        }
    }
    let mut members = serde_json::Map::new();
    for (account_id, mailboxes) in found {
        let mut per_account = serde_json::Map::new();
        for (mailbox, uids) in mailboxes {
            let wanted: Vec<u32> = uids.into_iter().collect();
            let mut kept: Vec<u32> = Vec::with_capacity(wanted.len());
            let mut unread = 0u64;
            // One custody lock hold per unit, released between units: a
            // foreground header read waits on this lock, and a broad view
            // over a large folder is tens of thousands of rows. Only each
            // row's uid and flags are read, never the whole header.
            for unit in wanted.chunks(HIDDEN_MEMBERS_UNIT) {
                let listed = match crate::custody::with_conn(state, |conn| {
                    mailvault_core::custody::cache::flags_by_uids(conn, &account_id, &mailbox, unit)
                }) {
                    Ok(listed) => listed,
                    // No cache to check against is unknown membership, not none.
                    Err(e) => {
                        tracing::warn!("[views] hidden_members: header cache unreadable for {account_id}: {e}");
                        return Ok(unavailable());
                    }
                };
                for (uid, flags) in &listed {
                    kept.push(*uid);
                    if !flags.iter().any(|flag| flag.eq_ignore_ascii_case("\\Seen")) {
                        unread += 1;
                    }
                }
            }
            if kept.is_empty() {
                continue;
            }
            kept.sort_unstable();
            per_account.insert(mailbox, serde_json::json!({ "uids": kept, "unread": unread }));
        }
        if !per_account.is_empty() {
            members.insert(account_id, Value::Object(per_account));
        }
    }
    Ok(serde_json::json!({ "available": true, "members": members }))
}

/// The flags of a row that holds no vault file come from the server, not from
/// the index. Such a row's file name is the only place the index keeps its
/// flags, and with no file there is nothing for a read-state change to rename,
/// so the row shows the flags it was indexed with for good. The header cache is
/// what every read-state writer (a sync, a mark read) patches, and it names the
/// same flags a file name would spell. A row with a vault copy keeps its file
/// name, which the reconcile renames; a row the cache has no entry for keeps
/// what the index says.
fn overlay_server_flags(state: &DaemonState, account_id: &str, rows: &mut [Value]) {
    let mut wanted: HashMap<String, Vec<u32>> = HashMap::new();
    for row in rows.iter() {
        let held = row.get("isArchived").and_then(Value::as_bool) == Some(true)
            || row.get("_localOnlyFolder").and_then(Value::as_bool) == Some(true);
        let (Some(mailbox), Some(uid)) = (
            row.get("_mailbox").and_then(Value::as_str),
            row.get("uid").and_then(Value::as_u64).and_then(|uid| u32::try_from(uid).ok()),
        ) else {
            continue;
        };
        if !held {
            wanted.entry(mailbox.to_owned()).or_default().push(uid);
        }
    }
    let mut server: HashMap<(String, u32), Vec<String>> = HashMap::new();
    for (mailbox, uids) in wanted {
        let Ok(headers) = crate::custody::with_conn(state, |conn| {
            mailvault_core::custody::cache::load_by_uids(conn, account_id, &mailbox, &uids)
        }) else {
            continue;
        };
        for header in headers {
            let Some(uid) = header.get("uid").and_then(Value::as_u64).and_then(|uid| u32::try_from(uid).ok()) else { continue };
            let imap: Vec<String> = header
                .get("flags")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                .unwrap_or_default();
            let name = mailvault_core::message_store::entry_name(uid, &mailvault_core::vault_flags::merge_flags(&[], &imap));
            server.insert((mailbox.clone(), uid), mailvault_core::message_store::flags_in_name(&name));
        }
    }
    for row in rows.iter_mut() {
        let key = (
            row.get("_mailbox").and_then(Value::as_str).unwrap_or("").to_owned(),
            row.get("uid").and_then(Value::as_u64).and_then(|uid| u32::try_from(uid).ok()).unwrap_or(0),
        );
        if let (Some(flags), Some(object)) = (server.get(&key), row.as_object_mut()) {
            object.insert("flags".into(), serde_json::json!(flags));
        }
    }
}

fn evaluate(
    state: &DaemonState,
    def: &ViewDef,
    accounts: &[Account],
    keys: &HashMap<String, Vec<String>>,
    limit: usize,
) -> Result<Value, String> {
    let now = now_secs();
    // Accounts the view filters alike are one statement. Every FTS probe runs
    // over the whole index whatever account it is for, so one statement per
    // account paid for the same match once per account: ~0.18s each on a
    // 19-account vault, held on the index lock a click waits on. An account
    // whose filters differ (its own address, its own bin, its own tags) gets
    // its own. No account named is every account: a view made before a second
    // account was added must not empty itself when one arrives.
    let mut batches: Vec<(SearchRequest, Vec<&Account>)> = Vec::new();
    for account in accounts.iter().filter(|account| def.accounts.is_empty() || def.accounts.contains(&account.account_id)) {
        let mut request = request_for(def, account, keys, now);
        request.account_id.clear();
        match batches.iter_mut().find(|(alike, _)| *alike == request) {
            Some((_, group)) => group.push(account),
            None => batches.push((request, vec![account])),
        }
    }
    let mut rows: Vec<Value> = Vec::new();
    let mut total = 0u64;
    for (mut request, group) in batches {
        request.account_ids = group.iter().map(|account| account.account_id.clone()).collect();
        // `views.counts` wants the totals and nothing else: no page, no row
        // JSON per view per account only to throw it away.
        request.limit = Some(limit);
        let page = match crate::search_index::search_page(&state.search_index, &request)? {
            // An index that cannot answer says so. An empty list would read as
            // "nothing matches this view", which is a different statement.
            Err(reason) => return Ok(serde_json::json!({ "available": false, "reason": reason, "rows": [] })),
            Ok(page) => page,
        };
        total += page.total;
        for account in group {
            let hits: Vec<_> = page.hits.iter().filter(|hit| hit.account_id == account.account_id).cloned().collect();
            // The custody read below walks every entry the account holds.
            if hits.is_empty() {
                continue;
            }
            let mut page = crate::search_index::assemble_rows(&mailvault_core::search_index::query::SearchPage {
                hits,
                total: 0,
                needles: page.needles.clone(),
            });
            // The same custody proof search reads: an archived copy the
            // server no longer holds is "local only" here too, not a row
            // that still offers to delete itself from the server.
            let custody = crate::custody::with_conn(state, |conn| {
                mailvault_core::custody::entries::entries_for_account(conn, &account.account_id)
            })
            .map(crate::handlers::mail_search::custody_by_vault_uid)
            .unwrap_or_default();
            for row in &mut page {
                let vault_dir = row.get("vaultDir").and_then(Value::as_str).unwrap_or("").to_owned();
                crate::handlers::mail_search::stamp_local_row(
                    row,
                    &account.account_id,
                    &vault_dir,
                    &account.known_mailboxes,
                    false,
                    &custody,
                );
            }
            overlay_server_flags(state, &account.account_id, &mut page);
            rows.append(&mut page);
        }
    }
    // Newest first across every account, the way the list already reads.
    // Cached key: re-parsing each date inside the comparator would run
    // `dateparse` O(n log n) times.
    rows.sort_by_cached_key(|row| {
        std::cmp::Reverse(row.get("date").and_then(Value::as_str).and_then(|d| mailparse::dateparse(d).ok()).unwrap_or(0))
    });
    rows.truncate(limit);
    Ok(serde_json::json!({ "available": true, "rows": rows, "total": total }))
}

/// `views.senders`: the senders of what the view finds with its sender rules
/// off, merged across accounts. `own` is an address any account in scope owns.
fn senders(
    state: &DaemonState,
    def: &ViewDef,
    accounts: &[Account],
    keys: &HashMap<String, Vec<String>>,
    limit: usize,
) -> Result<Value, String> {
    let now = now_secs();
    let open = ViewDef { senders: Vec::new(), exclude_senders: Vec::new(), ..def.clone() };
    let mut batches: Vec<(SearchRequest, Vec<&Account>)> = Vec::new();
    for account in accounts.iter().filter(|account| def.accounts.is_empty() || def.accounts.contains(&account.account_id)) {
        let mut request = request_for(&open, account, keys, now);
        request.account_id.clear();
        match batches.iter_mut().find(|(alike, _)| *alike == request) {
            Some((_, group)) => group.push(account),
            None => batches.push((request, vec![account])),
        }
    }
    let mut merged: std::collections::BTreeMap<String, (String, u64)> = std::collections::BTreeMap::new();
    let mut own: Vec<String> = Vec::new();
    for (mut request, group) in batches {
        request.account_ids = group.iter().map(|account| account.account_id.clone()).collect();
        own.extend(group.iter().flat_map(|account| own_addresses(account)));
        let counted = match crate::search_index::sender_counts(&state.search_index, &request, limit)? {
            Err(reason) => return Ok(serde_json::json!({ "available": false, "reason": reason, "senders": [] })),
            Ok(counted) => counted,
        };
        for sender in counted {
            let entry = merged.entry(sender.address).or_default();
            if entry.0.is_empty() {
                entry.0 = sender.name;
            }
            entry.1 += sender.count;
        }
    }
    let mut ranked: Vec<(String, String, u64)> = merged.into_iter().map(|(address, (name, count))| (address, name, count)).collect();
    ranked.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
    ranked.truncate(limit);
    let senders: Vec<Value> = ranked
        .into_iter()
        .map(|(address, name, count)| {
            let mine = own.contains(&address);
            serde_json::json!({ "address": address, "name": name, "count": count, "own": mine })
        })
        .collect();
    Ok(serde_json::json!({ "available": true, "senders": senders }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mailvault_core::search_index::{db as index_db, lock};
    use serde_json::json;

    fn st() -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-views-handler-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = DaemonState::for_test(dir.clone(), dir, true);
        state.seed_accounts_for_test(&["a"]);
        state
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> Value {
        let resp = route(s, method, &params, json!(1)).await.expect("routed");
        resp.result.unwrap_or_else(|| panic!("{method} failed: {:?}", resp.error))
    }

    /// One indexed message. `filename` carries the flags, exactly as the vault
    /// spells them.
    fn seed(conn: &rusqlite::Connection, uid: u32, filename: &str, subject: &str, attachments: bool, message_id: &str) {
        let row = json!({ "uid": uid, "subject": subject, "messageId": message_id, "from": {"address": "ann@x.test"} });
        conn.execute(
            "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, message_id, date_utc,
               from_addr_lc, from_name_lc, subject_lc, addrs_lc, has_attachments, body_state, row_json, flags)
             VALUES ('a','INBOX',?1,?2,0,0,?3,1788825600,'ann@x.test','ann',?4,'me@x.test',?5,1,?6,?7)",
            rusqlite::params![
                uid,
                filename,
                message_id,
                subject.to_lowercase(),
                attachments,
                row.to_string(),
                mailvault_core::message_store::flag_letters(&mailvault_core::message_store::flags_in_name(filename)),
            ],
        )
        .unwrap();
    }

    fn index(s: &Arc<DaemonState>) {
        let conn = index_db::open(&s.data_dir).unwrap();
        let p = mailvault_core::maildir::INFO_PREFIX;
        seed(&conn, 1, &format!("1{p}FS.eml"), "Starred one", false, "<one@x.test>");
        seed(&conn, 2, &format!("2{p}S.eml"), "Plain two", true, "<two@x.test>");
        seed(&conn, 3, &format!("3{p}.eml"), "Unread three", false, "<three@x.test>");
        index_db::meta_set(&conn, index_db::FIRST_PASS_DONE, "1").unwrap();
        *lock(&s.search_index.db) = Some(conn);
    }

    fn accounts() -> Value {
        json!([{ "accountId": "a", "address": "me@x.test", "knownMailboxes": ["INBOX"] }])
    }

    /// A message that holds no vault file has no file name to rename when its
    /// read state changes, so the index row keeps the flags it was indexed
    /// with. The server's flags (the header cache, patched by every read-state
    /// writer) are what such a row must show.
    #[tokio::test]
    async fn a_row_with_no_vault_copy_shows_the_server_flags_not_the_indexed_ones() {
        let s = st();
        index(&s);
        crate::custody::with_conn(&s, |conn| {
            let header = |uid: u32, flags: Value| json!({ "uid": uid, "flags": flags, "date": "Mon, 07 Sep 2026 10:00:00 +0000" });
            mailvault_core::custody::cache::save_headers(
                conn, "a", "INBOX",
                &json!({ "emails": [header(3, json!(["\\Seen"])), header(1, json!(["\\Seen"]))] }).to_string(),
            )
        })
        .unwrap();
        let out = call(&s, "views.evaluate", json!({ "def": {}, "accounts": accounts() })).await;
        let flags_of = |uid: u64| -> Vec<String> {
            let row = out["rows"].as_array().unwrap().iter().find(|r| r["uid"] == uid).unwrap();
            row["flags"].as_array().unwrap().iter().map(|f| f.as_str().unwrap().to_owned()).collect()
        };
        assert!(flags_of(3).contains(&"\\Seen".to_owned()), "read on the server, indexed unread: {:?}", flags_of(3));
        // Nothing cached for uid 2: its own file name stays the answer.
        assert!(flags_of(2).contains(&"\\Seen".to_owned()), "{:?}", flags_of(2));
        // The other way round: indexed starred, the server has since dropped the star.
        assert!(!flags_of(1).contains(&"\\Flagged".to_owned()), "{:?}", flags_of(1));
    }

    /// "Addressed to me" and "not from me" mean every address the account
    /// owns: mail to an alias is to you, and mail sent from one is yours.
    #[test]
    fn to_me_and_not_from_me_cover_every_alias() {
        let account: Account = serde_json::from_value(json!({
            "accountId": "a", "address": "Me@x.test", "aliases": ["Desk@x.test", "me@x.test", " "]
        }))
        .unwrap();
        let def = ViewDef { to_me: true, not_from_me: true, ..Default::default() };
        let request = request_for(&def, &account, &HashMap::new(), 0);
        assert_eq!(request.to_any, vec!["me@x.test".to_string(), "desk@x.test".to_string()]);
        assert_eq!(request.from_none, request.to_any);

        // An app that sends no aliases still gets the login alone.
        let bare: Account = serde_json::from_value(json!({ "accountId": "a", "address": "me@x.test" })).unwrap();
        assert_eq!(request_for(&def, &bare, &HashMap::new(), 0).to_any, vec!["me@x.test".to_string()]);
    }

    /// "Download attachments" on a view: only the messages it finds that carry
    /// one, even when the view itself does not ask for attachments.
    #[tokio::test]
    async fn exporting_a_views_attachments_writes_only_what_it_finds() {
        let s = st();
        index(&s);
        let cur = mailvault_core::vault_files::cur_path(&s.data_dir, "a", "INBOX");
        std::fs::create_dir_all(&cur).unwrap();
        let p = mailvault_core::maildir::INFO_PREFIX;
        let eml = "From: ann@x.test\r\nSubject: Plain two\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"B\"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nhi\r\n--B\r\nContent-Type: application/pdf; name=\"a.pdf\"\r\nContent-Disposition: attachment; filename=\"a.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--B--\r\n";
        std::fs::write(cur.join(format!("2{p}S.eml")), eml).unwrap();
        let dest = s.data_dir.join("out").join("View - Attachments");
        let mut events = s.events.subscribe();
        let started = call(&s, "views.export_attachments", json!({
            "def": {}, "accounts": accounts(), "destDir": dest.to_string_lossy(), "jobId": "v-1",
        })).await;
        assert_eq!(started, json!({"jobId": "v-1"}));
        let (progress, last) = crate::handlers::vault_files::finished_export(&mut events, "v-1").await;
        // Counted in messages: the one message the view found with an attachment.
        assert_eq!(progress.last().map(|f| (f["done"].clone(), f["total"].clone())), Some((json!(1), json!(1))));
        let out = &last["result"];
        assert_eq!(out["files"], 1, "{out}");
        assert_eq!(out["skipped"], 0, "{out}");
        assert!(dest.join("a.pdf").exists());
    }

    #[tokio::test]
    async fn exporting_a_searchs_rows_reads_exactly_those_messages() {
        let s = st();
        let cur = mailvault_core::vault_files::cur_path(&s.data_dir, "a", "INBOX");
        std::fs::create_dir_all(&cur).unwrap();
        let p = mailvault_core::maildir::INFO_PREFIX;
        let eml = "From: ann@x.test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"B\"\r\n\r\n--B\r\nContent-Type: application/pdf; name=\"b.pdf\"\r\nContent-Disposition: attachment; filename=\"b.pdf\"\r\n\r\nx\r\n--B--\r\n";
        std::fs::write(cur.join(format!("5{p}S.eml")), eml).unwrap();
        let dest = s.data_dir.join("out").join("Search - Attachments");
        let mut events = s.events.subscribe();
        call(&s, "views.export_attachments", json!({
            "messages": [{ "accountId": "a", "mailbox": "INBOX", "uid": 5 }, { "accountId": "a", "mailbox": "INBOX", "uid": 6 }],
            "destDir": dest.to_string_lossy(), "jobId": "v-2",
        })).await;
        let (_, last) = crate::handlers::vault_files::finished_export(&mut events, "v-2").await;
        let out = &last["result"];
        assert_eq!((out["files"].as_u64(), out["skipped"].as_u64()), (Some(1), Some(1)), "{out}");
        assert!(dest.join("b.pdf").exists());
    }

    /// The app knows which folder is the bin on this account; the daemon must
    /// never guess it from a name.
    #[tokio::test]
    async fn a_special_use_exclusion_is_resolved_through_the_account_that_named_it() {
        let s = st();
        {
            let conn = index_db::open(&s.data_dir).unwrap();
            let p = mailvault_core::maildir::INFO_PREFIX;
            seed(&conn, 1, &format!("1{p}S.eml"), "Kept", false, "<one@x.test>");
            conn.execute(
                "UPDATE messages SET vault_dir = 'Papierkorb' WHERE uid = 1",
                [],
            )
            .unwrap();
            seed(&conn, 2, &format!("2{p}S.eml"), "Also kept", false, "<two@x.test>");
            index_db::meta_set(&conn, index_db::FIRST_PASS_DONE, "1").unwrap();
            *lock(&s.search_index.db) = Some(conn);
        }
        let accounts = json!([{
            "accountId": "a", "address": "me@x.test",
            "knownMailboxes": ["INBOX", "Papierkorb"],
            "specialUse": { "\\Trash": "Papierkorb" }
        }]);
        let out = call(&s, "views.evaluate", json!({
            "def": { "excludeSpecial": ["\\Trash"] }, "accounts": accounts
        }))
        .await;
        let uids: Vec<u64> = out["rows"].as_array().unwrap().iter().map(|r| r["uid"].as_u64().unwrap()).collect();
        assert_eq!(uids, vec![2], "the message in this account's bin is left out");
    }

    /// The editor's account buttons narrow the view. The app hands over every
    /// account it has; the definition decides which of them the view reads.
    #[tokio::test]
    async fn a_view_reads_only_the_accounts_its_definition_names() {
        let s = st();
        index(&s);
        let both = json!([
            { "accountId": "a", "address": "me@x.test", "knownMailboxes": ["INBOX"] },
            { "accountId": "b", "address": "you@x.test", "knownMailboxes": ["INBOX"] }
        ]);
        let total = |out: Value| out["total"].as_u64().unwrap();
        let only_b = call(&s, "views.evaluate", json!({ "def": { "accounts": ["b"] }, "accounts": both })).await;
        assert_eq!(total(only_b), 0, "account a's mail is outside a view scoped to b");
        let only_a = call(&s, "views.evaluate", json!({ "def": { "accounts": ["a"] }, "accounts": both })).await;
        assert_eq!(total(only_a), 3);
        let every = call(&s, "views.evaluate", json!({ "def": { "accounts": [] }, "accounts": both })).await;
        assert_eq!(total(every), 3, "no account named is every account");
    }

    /// A view reads the same custody proof search does. An archived copy the
    /// server has deleted used to come back as a plain server row, offering to
    /// delete itself from a server that no longer holds it.
    #[tokio::test]
    async fn an_archived_copy_deleted_on_the_server_is_local_only_in_a_view() {
        let s = st();
        {
            let conn = index_db::open(&s.data_dir).unwrap();
            let p = mailvault_core::maildir::INFO_PREFIX;
            seed(&conn, 4, &format!("4{p}AS.eml"), "Deleted upstream", false, "<four@x.test>");
            index_db::meta_set(&conn, index_db::FIRST_PASS_DONE, "1").unwrap();
            *lock(&s.search_index.db) = Some(conn);
        }
        crate::custody::open_into(&s).unwrap();
        crate::custody::with_conn(&s, |conn| {
            mailvault_core::custody::entries::upsert(
                conn,
                "a",
                "INBOX",
                &[json!({"uid": 4, "source": "local", "serverDeleted": true})],
            )
            .map(|_| ())
        })
        .unwrap();
        let out = evaluate(&s, json!({})).await;
        let row = &out["rows"][0];
        assert_eq!(row["uid"], 4);
        assert_eq!(row["serverDeleted"], true);
        assert_eq!(row["source"], "local-only");
    }

    /// A view over every account ran one index statement per account, each
    /// re-running the same whole-index FTS match: ~0.18s an account on a real
    /// 19-account vault, under the one index lock, for the sidebar's badges as
    /// much as for the click. Accounts the view filters the same way are one
    /// statement; only an account whose filters differ gets its own.
    #[tokio::test]
    async fn a_view_over_accounts_it_filters_alike_asks_the_index_once() {
        let s = st();
        {
            let conn = index_db::open(&s.data_dir).unwrap();
            let p = mailvault_core::maildir::INFO_PREFIX;
            seed(&conn, 1, &format!("1{p}S.eml"), "Lease one", true, "<one@x.test>");
            seed(&conn, 2, &format!("2{p}S.eml"), "Lease two", true, "<two@x.test>");
            seed(&conn, 3, &format!("3{p}S.eml"), "Other", false, "<three@x.test>");
            conn.execute("UPDATE messages SET account_id = 'b', date_utc = date_utc + 60 WHERE uid = 2", []).unwrap();
            // The merge across accounts sorts by the row's own date.
            conn.execute(
                "UPDATE messages SET row_json = json_set(row_json, '$.date',
                   CASE uid WHEN 2 THEN 'Tue, 08 Sep 2026 10:01:00 +0000' ELSE 'Tue, 08 Sep 2026 10:00:00 +0000' END)",
                [],
            )
            .unwrap();
            index_db::meta_set(&conn, index_db::FIRST_PASS_DONE, "1").unwrap();
            *lock(&s.search_index.db) = Some(conn);
        }
        let three = json!([
            { "accountId": "a", "address": "me@x.test", "knownMailboxes": ["INBOX"] },
            { "accountId": "b", "address": "you@x.test", "knownMailboxes": ["INBOX"] },
            { "accountId": "c", "address": "them@x.test", "knownMailboxes": ["INBOX"] }
        ]);
        let out = call(&s, "views.evaluate", json!({ "def": { "hasAttachments": true }, "accounts": three })).await;
        assert_eq!(s.search_index.search_scopes.lock().unwrap().len(), 1, "one statement for three accounts");
        let rows: Vec<(String, u64)> = out["rows"].as_array().unwrap().iter()
            .map(|r| (r["_accountId"].as_str().unwrap().to_owned(), r["uid"].as_u64().unwrap()))
            .collect();
        assert_eq!(rows, vec![("b".to_owned(), 2), ("a".to_owned(), 1)], "newest first, each row its own account");
        assert_eq!(out["total"], 2);

        // "Addressed to me" names each account's own address: no longer alike.
        s.search_index.search_scopes.lock().unwrap().clear();
        call(&s, "views.evaluate", json!({ "def": { "toMe": true }, "accounts": three })).await;
        assert_eq!(s.search_index.search_scopes.lock().unwrap().len(), 3);

        // The badges: one statement per view, and the same total the click shows.
        s.search_index.search_scopes.lock().unwrap().clear();
        let total = evaluate_def(&s, &ViewDef { has_attachments: true, ..Default::default() }, &three);
        assert_eq!(total, 2);
        assert_eq!(s.search_index.search_scopes.lock().unwrap().len(), 1);
    }

    fn evaluate_def(s: &Arc<DaemonState>, def: &ViewDef, accounts: &Value) -> u64 {
        let accounts: Vec<Account> = serde_json::from_value(accounts.clone()).unwrap();
        super::evaluate(s, def, &accounts, &HashMap::new(), 0).unwrap()["total"].as_u64().unwrap()
    }

    async fn evaluate(s: &Arc<DaemonState>, def: Value) -> Value {
        call(s, "views.evaluate", json!({ "def": def, "accounts": accounts() })).await
    }

    /// One indexed message from `from`, in the mailbox `a`/INBOX.
    fn seed_from(conn: &rusqlite::Connection, uid: u32, from: &str, name: &str, subject: &str, message_id: &str) {
        let row = json!({ "uid": uid, "subject": subject, "messageId": message_id, "from": {"address": from, "name": name} });
        conn.execute(
            "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, message_id, date_utc,
               from_addr_lc, from_name_lc, subject_lc, addrs_lc, has_attachments, body_state, row_json, flags)
             VALUES ('a','INBOX',?1,?2,0,0,?3,1788825600,?4,?5,?6,?4,0,1,?7,'')",
            rusqlite::params![
                uid,
                format!("{uid}{}.eml", mailvault_core::maildir::INFO_PREFIX),
                message_id,
                from,
                name.to_lowercase(),
                subject.to_lowercase(),
                row.to_string(),
            ],
        )
        .unwrap();
    }

    /// The landlord's inbox: the utility's bills, the same word in a mail the
    /// landlord sent a tenant, and a newsletter that only mentions it.
    fn bills_index(s: &Arc<DaemonState>) {
        let conn = index_db::open(&s.data_dir).unwrap();
        seed_from(&conn, 1, "bills@servico.lt", "Servico, UAB", "Saskaita Nr 1 komunaliniai", "<bill1@servico.lt>");
        seed_from(&conn, 2, "bills@servico.lt", "Servico, UAB", "Saskaita Nr 2 komunaliniai", "<bill2@servico.lt>");
        seed_from(&conn, 3, "me@x.test", "Me", "Komunaliniai", "<mine@x.test>");
        seed_from(&conn, 4, "news@shop.test", "Shop", "Komunaliniai discounts", "<news@shop.test>");
        index_db::meta_set(&conn, index_db::FIRST_PASS_DONE, "1").unwrap();
        *lock(&s.search_index.db) = Some(conn);
    }

    fn uids_of(out: &Value) -> Vec<u64> {
        let mut uids: Vec<u64> = out["rows"].as_array().unwrap().iter().map(|r| r["uid"].as_u64().unwrap()).collect();
        uids.sort();
        uids
    }

    #[tokio::test]
    async fn a_view_that_names_its_senders_shows_nothing_else() {
        let s = st();
        bills_index(&s);
        let all = evaluate(&s, json!({})).await;
        assert_eq!(uids_of(&all), vec![1, 2, 3, 4], "no sender rule finds the mail sent to a tenant too");
        let only = evaluate(&s, json!({ "senders": ["servico.lt"] })).await;
        assert_eq!(uids_of(&only), vec![1, 2]);
        let none = evaluate(&s, json!({ "senders": ["ervico.lt"] })).await;
        assert_eq!(uids_of(&none), Vec::<u64>::new(), "a piece of a domain names nobody");
    }

    #[tokio::test]
    async fn a_blocked_sender_and_a_blocked_message_leave_the_view() {
        let s = st();
        bills_index(&s);
        let blocked = evaluate(&s, json!({ "excludeSenders": ["shop.test", "me@x.test"] })).await;
        assert_eq!(uids_of(&blocked), vec![1, 2]);
        let one = evaluate(&s, json!({ "senders": ["servico.lt"], "excludeMessages": ["bill2@servico.lt"] })).await;
        assert_eq!(uids_of(&one), vec![1], "one bill is kept out, its sender stays");
    }

    #[tokio::test]
    async fn a_views_senders_are_who_would_fill_it_most_first_and_mine_are_marked() {
        let s = st();
        bills_index(&s);
        let out = call(&s, "views.senders", json!({ "def": {}, "accounts": accounts() })).await;
        assert_eq!(out["available"], true);
        let senders = out["senders"].as_array().unwrap();
        assert_eq!(senders[0], json!({ "address": "bills@servico.lt", "name": "Servico, UAB", "count": 2, "own": false }));
        let mine = senders.iter().find(|s| s["address"] == "me@x.test").unwrap();
        assert_eq!(mine["own"], true, "the account's own address is flagged");
        // The sender rules themselves are what is being chosen: they do not
        // hide the senders they would block.
        let ruled = call(&s, "views.senders", json!({ "def": { "senders": ["servico.lt"] }, "accounts": accounts() })).await;
        assert_eq!(ruled["senders"].as_array().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn the_senders_say_unavailable_while_the_index_is_closed() {
        let s = st();
        let out = call(&s, "views.senders", json!({ "def": {}, "accounts": accounts() })).await;
        assert_eq!(out["available"], false);
    }

    #[tokio::test]
    async fn the_starters_are_there_the_first_time_the_app_asks() {
        let s = st();
        let listed = call(&s, "views.list", json!({})).await;
        let builtins: Vec<&str> = listed.as_array().unwrap().iter().filter_map(|v| v["builtin"].as_str()).collect();
        assert_eq!(builtins, vec!["needs-reply", "starred", "attachments"]);
    }

    /// Registration guard: the routes are reached through
    /// `server::handle_request`, and a module that is never wired in answers
    /// "Unknown method" to an app that looks entirely healthy otherwise.
    #[tokio::test]
    async fn the_routes_are_reachable_through_the_servers_dispatch() {
        let s = st();
        let resp = crate::server::handle_request_for_test(&s, "views.list", json!({})).await;
        assert!(resp.result.is_some(), "views.list is not routed: {:?}", resp.error);
    }

    #[tokio::test]
    async fn a_view_round_trips_and_can_be_deleted() {
        let s = st();
        let saved = call(&s, "views.save", json!({ "view": {
            "id": "v1", "name": "Receipts", "icon": "tag", "position": 0, "builtin": null,
            "def": { "query": "invoice", "hasAttachments": true }
        }})).await;
        assert_eq!(saved["name"], "Receipts");
        assert!(call(&s, "views.list", json!({})).await.as_array().unwrap().iter().any(|v| v["id"] == "v1"));
        call(&s, "views.delete", json!({ "id": "v1" })).await;
        assert!(!call(&s, "views.list", json!({})).await.as_array().unwrap().iter().any(|v| v["id"] == "v1"));
    }

    #[tokio::test]
    async fn reorder_route_persists_the_sidebar_order() {
        let s = st();
        let listed = call(&s, "views.list", json!({})).await;
        let mut ids: Vec<String> = listed.as_array().unwrap().iter()
            .map(|view| view["id"].as_str().unwrap().to_string()).collect();
        ids.reverse();
        call(&s, "views.reorder", json!({ "ids": ids })).await;
        let after = call(&s, "views.list", json!({})).await;
        let order: Vec<&str> = after.as_array().unwrap().iter().map(|view| view["id"].as_str().unwrap()).collect();
        assert_eq!(order, ids.iter().map(String::as_str).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn starred_returns_only_the_flagged_message() {
        let s = st();
        index(&s);
        let out = evaluate(&s, json!({ "starred": true })).await;
        assert_eq!(out["available"], true);
        let uids: Vec<u64> = out["rows"].as_array().unwrap().iter().map(|r| r["uid"].as_u64().unwrap()).collect();
        assert_eq!(uids, vec![1]);
    }

    #[tokio::test]
    async fn a_row_carries_the_account_and_mailbox_the_list_needs() {
        let s = st();
        index(&s);
        let out = evaluate(&s, json!({ "starred": true })).await;
        let row = &out["rows"][0];
        assert_eq!(row["_accountId"], "a");
        assert_eq!(row["_mailbox"], "INBOX");
        let flags: Vec<&str> = row["flags"].as_array().unwrap().iter().filter_map(|f| f.as_str()).collect();
        assert!(flags.contains(&"\\Flagged"), "{flags:?}");
    }

    #[tokio::test]
    async fn unread_is_the_messages_with_no_seen_flag() {
        let s = st();
        index(&s);
        let out = evaluate(&s, json!({ "unread": true })).await;
        let uids: Vec<u64> = out["rows"].as_array().unwrap().iter().map(|r| r["uid"].as_u64().unwrap()).collect();
        assert_eq!(uids, vec![3]);
    }

    /// The identities come from `app.db`, the rows from the index. Neither
    /// store knows about the other; the handler is what puts them together.
    #[tokio::test]
    async fn a_view_filtered_by_tag_returns_only_the_tagged_messages() {
        let s = st();
        index(&s);
        let tag = crate::handlers::tags::route(&s, "tags.ensure", &json!({"name": "Receipts"}), json!(1))
            .await
            .expect("routed")
            .result
            .expect("ensure");
        let tag_id = tag["id"].as_str().unwrap().to_string();
        crate::handlers::tags::route(
            &s,
            "tags.assign",
            &json!({"tagId": tag_id, "items": [{"accountId": "a", "mailbox": "INBOX", "uid": 2, "messageId": "<two@x.test>"}]}),
            json!(1),
        )
        .await
        .expect("routed")
        .result
        .expect("assign");

        let carried = crate::handlers::tags::route(
            &s,
            "tags.for_messages",
            &json!({"items": [{"accountId": "a", "mailbox": "INBOX", "uid": 2, "messageId": "<two@x.test>"}]}),
            json!(1),
        )
        .await
        .expect("routed")
        .result
        .expect("for_messages");
        assert_eq!(carried["tags"], json!([[tag_id]]), "the assignment landed");

        let out = evaluate(&s, json!({ "tags": [tag_id] })).await;
        let uids: Vec<u64> = out["rows"].as_array().unwrap().iter().map(|r| r["uid"].as_u64().unwrap()).collect();
        assert_eq!(uids, vec![2]);
    }

    /// Custom fields narrow a view the same way tags do: the identities come
    /// from `app.db`, the rows from the index.
    #[tokio::test]
    async fn a_view_filtered_by_a_custom_field_returns_only_the_messages_holding_that_value() {
        let s = st();
        index(&s);
        crate::handlers::fields::route(
            &s,
            "fields.save",
            &json!({"field": {"id": "f1", "scope": "a", "name": "Priority", "kind": "select",
                              "options": [{"id": "hi", "label": "High"}]}}),
            json!(1),
        )
        .await
        .expect("routed")
        .result
        .expect("save");
        crate::handlers::fields::route(
            &s,
            "fields.set",
            &json!({"item": {"accountId": "a", "mailbox": "INBOX", "uid": 3, "messageId": "<three@x.test>"},
                    "fieldId": "f1", "value": "hi"}),
            json!(1),
        )
        .await
        .expect("routed")
        .result
        .expect("set");

        let out = evaluate(&s, json!({ "fields": [{"fieldId": "f1", "op": "is", "value": "hi"}] })).await;
        let uids: Vec<u64> = out["rows"].as_array().unwrap().iter().map(|r| r["uid"].as_u64().unwrap()).collect();
        assert_eq!(uids, vec![3]);
    }

    /// Two filters are an AND, not a pile: a message has to satisfy both.
    #[tokio::test]
    async fn a_tag_and_a_field_together_narrow_to_what_carries_both() {
        let s = st();
        index(&s);
        let tag = crate::handlers::tags::route(&s, "tags.ensure", &json!({"name": "Clients"}), json!(1))
            .await
            .expect("routed")
            .result
            .expect("ensure")["id"]
            .as_str()
            .unwrap()
            .to_string();
        crate::handlers::tags::route(
            &s,
            "tags.assign",
            &json!({"tagId": tag, "items": [
                {"accountId": "a", "mailbox": "INBOX", "uid": 2, "messageId": "<two@x.test>"},
                {"accountId": "a", "mailbox": "INBOX", "uid": 3, "messageId": "<three@x.test>"}
            ]}),
            json!(1),
        )
        .await
        .expect("routed")
        .result
        .expect("assign");
        crate::handlers::fields::route(
            &s,
            "fields.save",
            &json!({"field": {"id": "f1", "scope": "a", "name": "Priority", "kind": "text"}}),
            json!(1),
        )
        .await
        .expect("routed")
        .result
        .expect("save");
        crate::handlers::fields::route(
            &s,
            "fields.set",
            &json!({"item": {"accountId": "a", "mailbox": "INBOX", "uid": 3, "messageId": "<three@x.test>"},
                    "fieldId": "f1", "value": "urgent"}),
            json!(1),
        )
        .await
        .expect("routed")
        .result
        .expect("set");

        let out = evaluate(&s, json!({
            "tags": [tag],
            "fields": [{"fieldId": "f1", "op": "is", "value": "urgent"}]
        }))
        .await;
        let uids: Vec<u64> = out["rows"].as_array().unwrap().iter().map(|r| r["uid"].as_u64().unwrap()).collect();
        assert_eq!(uids, vec![3]);
    }

    #[tokio::test]
    async fn a_view_filtered_by_a_tag_nobody_used_returns_nothing_not_everything() {
        let s = st();
        index(&s);
        let out = evaluate(&s, json!({ "tags": ["no-such-tag"] })).await;
        assert_eq!(out["available"], true);
        assert_eq!(out["rows"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn counts_answer_per_view_without_the_rows() {
        let s = st();
        index(&s);
        call(&s, "views.list", json!({})).await;
        let counts = call(&s, "views.counts", json!({ "accounts": accounts() })).await;
        let starred_id = call(&s, "views.list", json!({})).await.as_array().unwrap().iter()
            .find(|v| v["builtin"] == "starred").unwrap()["id"].as_str().unwrap().to_string();
        assert_eq!(counts[starred_id], 1);
    }

    /// A count of zero is a claim about the mail. While the index cannot
    /// answer, the honest reply is no counts at all.
    #[tokio::test]
    async fn counts_say_nothing_rather_than_zero_while_the_index_is_closed() {
        let s = st();
        call(&s, "views.list", json!({})).await;
        let counts = call(&s, "views.counts", json!({ "accounts": accounts() })).await;
        assert_eq!(counts, json!({}));
    }

    /// An index that cannot answer must say so. Returning an empty list would
    /// read as "nothing matches this view", which is a different statement.
    #[tokio::test]
    async fn a_closed_index_says_it_cannot_answer_rather_than_answering_nothing() {
        let s = st();
        let out = evaluate(&s, json!({ "starred": true })).await;
        assert_eq!(out["available"], false);
        assert_eq!(out["reason"], "unavailable");
        assert!(out["rows"].as_array().map_or(true, |rows| rows.is_empty()));
    }

    /// The view editor's sender typeahead reads the same index the view runs
    /// on: every sender it offers is one the view can find.
    #[tokio::test]
    async fn suggest_senders_offers_the_indexed_senders_with_their_counts() {
        let s = st();
        index(&s);
        let out = call(&s, "views.suggest_senders", json!({ "prefix": "An", "accounts": ["a"], "limit": 8 })).await;
        assert_eq!(out, json!([{ "address": "ann@x.test", "name": "", "count": 3 }]));
        let other = call(&s, "views.suggest_senders", json!({ "prefix": "an", "accounts": ["b"] })).await;
        assert_eq!(other, json!([]), "another account's senders are not offered");
    }

    /// A suggestion list is a convenience: while the index is closed there is
    /// nothing to offer, which is not a failure the editor should show.
    #[tokio::test]
    async fn suggest_senders_offers_nothing_while_the_index_is_closed() {
        let s = st();
        let out = call(&s, "views.suggest_senders", json!({ "prefix": "ann", "accounts": ["a"] })).await;
        assert_eq!(out, json!([]));
    }

    /// The view editor's query-field typeahead reads the same index the view
    /// runs on: every term it offers is one that index's subjects carry.
    #[tokio::test]
    async fn suggest_terms_offers_indexed_terms_with_counts() {
        let s = st();
        index(&s);
        let out = call(&s, "views.suggest_terms", json!({ "prefix": "sta", "accounts": ["a"] })).await;
        assert_eq!(out, json!([{ "term": "starred", "count": 1 }]));
        let other = call(&s, "views.suggest_terms", json!({ "prefix": "sta", "accounts": ["b"] })).await;
        assert_eq!(other, json!([]), "another account's terms are not offered");
    }

    /// Every saved view's members, unioned per account and mailbox, narrowed
    /// to what the header cache still lists, with the unread count taken from
    /// the cached (server) flags.
    #[tokio::test]
    async fn hidden_members_unions_every_view_and_keeps_only_cached_uids() {
        let s = st();
        index(&s); // uids 1 (starred, Seen), 2 (attachments, Seen), 3 (unread)
        crate::custody::with_conn(&s, |conn| {
            let h = |uid: u32, flags: Value| json!({ "uid": uid, "flags": flags, "date": "Mon, 07 Sep 2026 10:00:00 +0000" });
            mailvault_core::custody::cache::save_headers(
                conn, "a", "INBOX",
                &json!({ "emails": [h(1, json!(["\\Seen", "\\Flagged"])), h(2, json!(["\\Seen"])), h(3, json!([]))] }).to_string(),
            )
        })
        .unwrap();
        // Seed the starters first, then drop them, so only v1 and v2 count:
        // a first `ensure_starters` after the deletes would bring them back.
        call(&s, "views.list", json!({})).await;
        for id in ["builtin-needs-reply", "builtin-starred", "builtin-attachments"] {
            call(&s, "views.delete", json!({ "id": id })).await;
        }
        call(&s, "views.save", json!({ "view": { "id": "v1", "name": "S", "icon": "star", "position": 0, "builtin": null, "def": { "starred": true } } })).await;
        call(&s, "views.save", json!({ "view": { "id": "v2", "name": "U", "icon": "mail", "position": 1, "builtin": null, "def": { "unread": true } } })).await;
        let out = call(&s, "views.hidden_members", json!({ "accounts": accounts() })).await;
        assert_eq!(out["available"], true, "{out}");
        let mut uids: Vec<u64> =
            out["members"]["a"]["INBOX"]["uids"].as_array().unwrap().iter().map(|u| u.as_u64().unwrap()).collect();
        uids.sort();
        assert_eq!(uids, vec![1, 3], "uid 2 is in no view: {out}");
        assert_eq!(out["members"]["a"]["INBOX"]["unread"], 1, "{out}");

        // `viewIds` narrows the union to the views the person picked; an
        // empty pick hides nothing.
        let only_v1 = call(&s, "views.hidden_members", json!({ "accounts": accounts(), "viewIds": ["v1"] })).await;
        assert_eq!(only_v1["members"]["a"]["INBOX"]["uids"], json!([1]), "{only_v1}");
        let none = call(&s, "views.hidden_members", json!({ "accounts": accounts(), "viewIds": [] })).await;
        assert_eq!(none["available"], true, "{none}");
        assert_eq!(none["members"], json!({}), "{none}");
    }

    /// A message the header cache no longer lists is not on the list to hide.
    #[tokio::test]
    async fn hidden_members_drops_uids_the_header_cache_no_longer_holds() {
        let s = st();
        index(&s);
        crate::custody::with_conn(&s, |conn| {
            mailvault_core::custody::cache::save_headers(
                conn, "a", "INBOX",
                &json!({ "emails": [json!({ "uid": 2, "flags": ["\\Seen"], "date": "Mon, 07 Sep 2026 10:00:00 +0000" })] }).to_string(),
            )
        })
        .unwrap();
        call(&s, "views.save", json!({ "view": { "id": "all", "name": "All", "icon": "inbox", "position": 0, "builtin": null, "def": {} } })).await;
        let out = call(&s, "views.hidden_members", json!({ "accounts": accounts() })).await;
        assert_eq!(out["members"]["a"]["INBOX"]["uids"], json!([2]), "{out}");
        assert_eq!(out["members"]["a"]["INBOX"]["unread"], 0, "{out}");
    }

    /// A folder past one custody unit (900 uids) is read in several lock
    /// holds; every unit's uids and unread count add up.
    #[tokio::test]
    async fn hidden_members_accumulates_across_custody_units() {
        let s = st();
        let total = HIDDEN_MEMBERS_UNIT as u32 + 150;
        {
            let conn = index_db::open(&s.data_dir).unwrap();
            let p = mailvault_core::maildir::INFO_PREFIX;
            conn.execute_batch("BEGIN").unwrap();
            for uid in 1..=total {
                seed(&conn, uid, &format!("{uid}{p}S.eml"), "Bulk", false, &format!("<b{uid}@x.test>"));
            }
            conn.execute_batch("COMMIT").unwrap();
            index_db::meta_set(&conn, index_db::FIRST_PASS_DONE, "1").unwrap();
            *lock(&s.search_index.db) = Some(conn);
        }
        // Every uid cached, plus one the index does not hold; every tenth is
        // unread on the server.
        let emails: Vec<Value> = (1..=total + 1)
            .map(|uid| {
                let flags = if uid % 10 == 0 { json!([]) } else { json!(["\\Seen"]) };
                json!({ "uid": uid, "flags": flags, "date": "Mon, 07 Sep 2026 10:00:00 +0000" })
            })
            .collect();
        crate::custody::with_conn(&s, |conn| {
            mailvault_core::custody::cache::save_headers(conn, "a", "INBOX", &json!({ "emails": emails }).to_string())
        })
        .unwrap();
        call(&s, "views.save", json!({ "view": { "id": "all", "name": "All", "icon": "inbox", "position": 0, "builtin": null, "def": {} } })).await;
        let out = call(&s, "views.hidden_members", json!({ "accounts": accounts() })).await;
        let uids: Vec<u64> =
            out["members"]["a"]["INBOX"]["uids"].as_array().unwrap().iter().map(|u| u.as_u64().unwrap()).collect();
        assert_eq!(uids, (1..=u64::from(total)).collect::<Vec<_>>());
        assert_eq!(out["members"]["a"]["INBOX"]["unread"], u64::from(total / 10));
    }

    /// A folder only the vault holds is never hidden: the list it would be
    /// hidden from does not show it.
    #[tokio::test]
    async fn hidden_members_skips_local_only_folders() {
        let s = st();
        index(&s);
        let out = call(&s, "views.hidden_members", json!({
            "accounts": [{ "accountId": "a", "address": "me@x.test", "knownMailboxes": ["Sent"] }]
        }))
        .await;
        assert_eq!(out["available"], true, "{out}");
        assert_eq!(out["members"], json!({}), "{out}");
    }

    /// Unknown membership is not "nothing to hide": the app shows everything.
    #[tokio::test]
    async fn hidden_members_is_unavailable_without_an_index() {
        let s = st(); // no index()
        let out = call(&s, "views.hidden_members", json!({ "accounts": accounts() })).await;
        assert_eq!(out["available"], false);
        assert_eq!(out["members"], json!({}));
    }

    /// One indexed message with its words in the full-text tables, the way a
    /// sweep writes it: the `messages` row, then `msg_fts` under its id.
    fn seed_text(conn: &rusqlite::Connection, uid: u32, name: &str, address: &str, subject: &str, body: &str) {
        seed_text_in(conn, "a", uid, name, address, subject, body);
    }

    fn seed_text_in(conn: &rusqlite::Connection, account: &str, uid: u32, name: &str, address: &str, subject: &str, body: &str) {
        let p = mailvault_core::maildir::INFO_PREFIX;
        let row = json!({ "uid": uid, "subject": subject, "from": {"name": name, "address": address} });
        conn.execute(
            "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, message_id, date_utc,
               from_addr_lc, from_name_lc, subject_lc, addrs_lc, has_attachments, body_state, row_json, flags)
             VALUES (?8,'INBOX',?1,?2,0,0,?3,1788825600,?4,?5,?6,'me@x.test',0,1,?7,'S')",
            rusqlite::params![
                uid,
                format!("{uid}{p}S.eml"),
                format!("<{uid}@x.test>"),
                address.to_lowercase(),
                name.to_lowercase(),
                subject.to_lowercase(),
                row.to_string(),
                account,
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO msg_fts(rowid, subject, addrs, body, attach) VALUES (?1, ?2, '', ?3, '')",
            rusqlite::params![conn.last_insert_rowid(), subject, body],
        )
        .unwrap();
    }

    fn open_index(s: &Arc<DaemonState>, fill: impl FnOnce(&rusqlite::Connection)) {
        let conn = index_db::open(&s.data_dir).unwrap();
        fill(&conn);
        index_db::meta_set(&conn, index_db::FIRST_PASS_DONE, "1").unwrap();
        *lock(&s.search_index.db) = Some(conn);
    }

    /// Hovering a word: who sends it and what it is about, most first.
    #[tokio::test]
    async fn keyword_detail_groups_senders_by_address_and_subjects_without_reply_prefixes() {
        let s = st();
        open_index(&s, |conn| {
            seed_text(conn, 1, "Ann", "ann@x.test", "Fondue night", "bring fondue");
            seed_text(conn, 2, "Ann", "ANN@x.test", "Re: Fondue night", "more fondue");
            seed_text(conn, 3, "Bob", "bob@x.test", "Fondue recipe", "the fondue");
            seed_text(conn, 4, "Cat", "cat@x.test", "Other", "nothing here");
        });
        let out = call(&s, "views.keyword_detail", json!({ "term": "fondue", "accounts": ["a"] })).await;
        assert_eq!(out["available"], true, "{out}");
        assert_eq!(out["total"], 3, "{out}");
        assert_eq!(
            out["senders"],
            json!([
                { "name": "Ann", "address": "ann@x.test", "count": 2 },
                { "name": "Bob", "address": "bob@x.test", "count": 1 },
            ])
        );
        assert_eq!(
            out["subjects"],
            json!([
                { "subject": "Fondue night", "sender": "Ann", "count": 2 },
                { "subject": "Fondue recipe", "sender": "Bob", "count": 1 },
            ])
        );
        // The `views.evaluate` account shape reads the same.
        let objects = call(&s, "views.keyword_detail", json!({ "term": "fondue", "accounts": accounts() })).await;
        assert_eq!(objects, out);
    }

    /// The accounts named are the accounts read; none named is every one.
    /// `total` is every match, not just the rows aggregated.
    #[tokio::test]
    async fn keyword_detail_reads_only_the_accounts_it_names() {
        let s = st();
        open_index(&s, |conn| {
            seed_text_in(conn, "a", 1, "Ann", "ann@x.test", "Fondue night", "fondue");
            seed_text_in(conn, "b", 1, "Bob", "bob@x.test", "Fondue recipe", "fondue");
            seed_text_in(conn, "b", 2, "Bob", "bob@x.test", "Fondue again", "fondue");
        });
        let only_a = call(&s, "views.keyword_detail", json!({ "term": "fondue", "accounts": ["a"] })).await;
        assert_eq!(only_a["total"], 1, "{only_a}");
        assert_eq!(only_a["senders"], json!([{ "name": "Ann", "address": "ann@x.test", "count": 1 }]));
        let every = call(&s, "views.keyword_detail", json!({ "term": "fondue" })).await;
        assert_eq!(every["total"], 3, "{every}");
        assert_eq!(every["senders"][0], json!({ "name": "Bob", "address": "bob@x.test", "count": 2 }));
        let empty = call(&s, "views.keyword_detail", json!({ "term": "fondue", "accounts": [] })).await;
        assert_eq!(empty, every);
    }

    #[tokio::test]
    async fn keyword_detail_is_unavailable_without_an_index() {
        let s = st();
        let out = call(&s, "views.keyword_detail", json!({ "term": "fondue", "accounts": ["a"] })).await;
        assert_eq!(out["available"], false);
        assert_eq!(out["senders"], json!([]));
        assert_eq!(out["subjects"], json!([]));
    }

    /// 61 indexed messages: uid 1 is the one opened, "meeting" is in half the
    /// mail, "budget" in exactly a fifth of the first 60, uid 61 is listed but
    /// its body not read yet.
    fn keyword_index(s: &Arc<DaemonState>) {
        open_index(s, |conn| {
            seed_text(conn, 1, "Ann", "ann@x.test", "Quokka fondue", "quokka fondue meeting budget");
            seed_text(conn, 2, "Ann", "ann@x.test", "", "fondue meeting");
            for uid in 3..=30 {
                seed_text(conn, uid, "Bob", "bob@x.test", "", "meeting agenda");
            }
            for uid in 31..=41 {
                seed_text(conn, uid, "Cat", "cat@x.test", "", "lunch budget");
            }
            for uid in 42..=60 {
                seed_text(conn, uid, "Cat", "cat@x.test", "", "lunch plans");
            }
            seed_text(conn, 61, "Dan", "dan@x.test", "", "");
            conn.execute("UPDATE messages SET body_state = 0 WHERE uid = 61", []).unwrap();
        });
        let cur = mailvault_core::vault_files::cur_path(&s.data_dir, "a", "INBOX");
        std::fs::create_dir_all(&cur).unwrap();
        let p = mailvault_core::maildir::INFO_PREFIX;
        for uid in [1, 61, 99] {
            std::fs::write(cur.join(format!("{uid}{p}S.eml")), keyword_eml("quokka fondue meeting budget")).unwrap();
        }
    }

    fn keyword_eml(first_line: &str) -> String {
        format!(
            "From: ann@x.test\r\nSubject: Quokka fondue\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\n{first_line}\r\nunseenword here\r\n> quotedword\r\n"
        )
    }

    fn terms_of(out: &Value) -> Vec<String> {
        out["keywords"].as_array().unwrap().iter().map(|k| k["term"].as_str().unwrap().to_owned()).collect()
    }

    /// The open message's distinctive words: its own rare words, never a word
    /// a fifth of the mailbox uses, never a quoted line, and (once the index
    /// holds the message's body) never a word the index has not seen.
    #[tokio::test]
    async fn keywords_rank_the_messages_rare_words_against_the_index() {
        let s = st();
        keyword_index(&s);
        let params = json!({ "accountId": "a", "mailbox": "INBOX", "uid": 1 });
        let out = call(&s, "views.keywords", params.clone()).await;
        assert_eq!(
            out,
            json!({ "available": true, "keywords": [
                { "term": "quokka", "tf": 4, "df": 1, "kind": "word", "source": "body" },
                { "term": "fondue", "tf": 4, "df": 2, "kind": "word", "source": "body" },
                // Right at the cut: kept, with its exact count.
                { "term": "budget", "tf": 1, "df": 12, "kind": "word", "source": "body" },
            ] })
        );
        assert_eq!(call(&s, "views.keywords", params).await, out, "asked again, same answer");

        let fresh = call(&s, "views.keywords", json!({ "accountId": "a", "mailbox": "INBOX", "uid": 99 })).await;
        let terms = terms_of(&fresh);
        assert!(terms.contains(&"unseenword".to_owned()), "not in the index at all: {fresh}");
        assert!(!terms.contains(&"meeting".to_owned()), "a fifth of the mail is not distinctive: {fresh}");
        assert!(!terms.contains(&"quotedword".to_owned()), "{fresh}");
    }

    fn kinds_of(out: &Value, kind: &str) -> Vec<(String, String)> {
        out["keywords"].as_array().unwrap().iter()
            .filter(|k| k["kind"] == kind)
            .map(|k| (k["term"].as_str().unwrap().to_owned(), k["source"].as_str().unwrap().to_owned()))
            .collect()
    }

    /// A utility bill: the address is in the body, the reference number only
    /// in the attached text. The attachment is read only when asked for.
    #[tokio::test]
    async fn keywords_offer_an_address_and_an_attached_reference_number() {
        let s = st();
        keyword_index(&s);
        let cur = mailvault_core::vault_files::cur_path(&s.data_dir, "a", "INBOX");
        let p = mailvault_core::maildir::INFO_PREFIX;
        let eml = "From: ann@x.test\r\nSubject: Vandens mokejimas\r\nMIME-Version: 1.0\r\n\
            Content-Type: multipart/mixed; boundary=\"B\"\r\n\r\n\
            --B\r\nContent-Type: text/plain\r\n\r\nPaslaugos vieta: Mindaugo g. 30-49, Vilnius\r\n\
            --B\r\nContent-Type: text/plain; name=\"bill.txt\"\r\n\
            Content-Disposition: attachment; filename=\"bill.txt\"\r\n\r\nSaskaita faktura BV530133\r\n--B--\r\n";
        std::fs::write(cur.join(format!("98{p}S.eml")), eml).unwrap();
        let params = json!({ "accountId": "a", "mailbox": "INBOX", "uid": 98 });

        let first = call(&s, "views.keywords", params.clone()).await;
        assert_eq!(kinds_of(&first, "phrase"), vec![("Mindaugo g. 30-49".to_owned(), "body".to_owned())], "{first}");
        assert!(kinds_of(&first, "identifier").is_empty(), "the attachment is not read yet: {first}");

        let mut with = params;
        with["withAttachments"] = json!(true);
        let full = call(&s, "views.keywords", with).await;
        assert_eq!(kinds_of(&full, "identifier"), vec![("BV530133".to_owned(), "attachment".to_owned())], "{full}");
        assert_eq!(kinds_of(&full, "phrase"), vec![("Mindaugo g. 30-49".to_owned(), "body".to_owned())], "{full}");
    }

    /// A listed message whose body the index has not read yet has words the
    /// index never saw; they are its words, not noise.
    #[tokio::test]
    async fn keywords_keep_unseen_words_while_the_body_is_not_indexed() {
        let s = st();
        keyword_index(&s);
        let out = call(&s, "views.keywords", json!({ "accountId": "a", "mailbox": "INBOX", "uid": 61 })).await;
        let terms = terms_of(&out);
        assert!(terms.contains(&"unseenword".to_owned()), "{out}");
        assert!(terms.contains(&"here".to_owned()), "{out}");
    }

    /// Each probe stops counting where the "too common" cut drops the word
    /// anyway; under the cap the count is exact.
    #[tokio::test]
    async fn a_df_probe_stops_at_the_cap() {
        let s = st();
        keyword_index(&s);
        let index = &s.search_index;
        let count = |term: &str, cap: Option<u64>| crate::search_index::term_doc_count(index, term, cap).unwrap().unwrap();
        assert_eq!(count("meeting", None), 30);
        assert_eq!(count("meeting", Some(13)), 13, "capped above the cut");
        assert_eq!(count("budget", Some(13)), 12, "exact below it");
        assert_eq!(count("fondue", Some(13)), 2);
    }

    /// A remembered answer still goes through the readiness gate: an index
    /// switched off, or rebuilding, answers nothing.
    #[tokio::test]
    async fn a_cached_answer_is_not_served_by_an_index_that_cannot_answer() {
        let s = st();
        keyword_index(&s);
        let params = json!({ "accountId": "a", "mailbox": "INBOX", "uid": 1 });
        assert_eq!(call(&s, "views.keywords", params.clone()).await["available"], true);
        *crate::search_index::g(&s.search_index.enabled) = Some(false);
        assert_eq!(call(&s, "views.keywords", params.clone()).await, json!({ "available": false, "keywords": [] }));
        *crate::search_index::g(&s.search_index.enabled) = None;
        lock(&s.search_index.db)
            .as_ref()
            .unwrap()
            .execute("DELETE FROM meta WHERE key = ?1", [index_db::FIRST_PASS_DONE])
            .unwrap();
        assert_eq!(call(&s, "views.keywords", params).await, json!({ "available": false, "keywords": [] }));
    }

    /// A uid reused after a mailbox reset names a different message: the
    /// answer cached for the old one is not its answer.
    #[tokio::test]
    async fn a_reused_uid_is_not_answered_from_the_old_messages_cache() {
        let s = st();
        keyword_index(&s);
        let params = json!({ "accountId": "a", "mailbox": "INBOX", "uid": 1 });
        assert!(terms_of(&call(&s, "views.keywords", params.clone()).await).contains(&"quokka".to_owned()));
        {
            let guard = lock(&s.search_index.db);
            let conn = guard.as_ref().unwrap();
            let id: i64 = conn.query_row("SELECT id FROM messages WHERE uid = 1", [], |r| r.get(0)).unwrap();
            conn.execute("UPDATE messages SET message_id = '<new-1@x.test>' WHERE id = ?1", [id]).unwrap();
            conn.execute("DELETE FROM msg_fts WHERE rowid = ?1", [id]).unwrap();
            conn.execute(
                "INSERT INTO msg_fts(rowid, subject, addrs, body, attach) VALUES (?1, 'Quokka fondue', '', 'zebra crossing', '')",
                [id],
            )
            .unwrap();
        }
        let cur = mailvault_core::vault_files::cur_path(&s.data_dir, "a", "INBOX");
        let p = mailvault_core::maildir::INFO_PREFIX;
        std::fs::write(cur.join(format!("1{p}S.eml")), keyword_eml("zebra crossing")).unwrap();
        let out = call(&s, "views.keywords", params).await;
        assert!(terms_of(&out).contains(&"zebra".to_owned()), "{out}");
    }

    /// A message whose body the index has not read yet (a folder still being
    /// indexed, an On Demand one) is answered from the cache too: stepping
    /// through such a folder with the builder open must not re-read (or
    /// fetch) the message and re-probe the index on every keypress. The body
    /// reaching the index changes the key, so the answer is worked out again.
    #[tokio::test]
    async fn a_not_yet_indexed_bodys_answer_is_cached_until_the_body_is_indexed() {
        let s = st();
        keyword_index(&s);
        let params = json!({ "accountId": "a", "mailbox": "INBOX", "uid": 61 });
        let first = call(&s, "views.keywords", params.clone()).await;
        assert!(terms_of(&first).contains(&"unseenword".to_owned()), "{first}");
        let cur = mailvault_core::vault_files::cur_path(&s.data_dir, "a", "INBOX");
        let eml = cur.join(format!("61{}S.eml", mailvault_core::maildir::INFO_PREFIX));
        std::fs::remove_file(&eml).unwrap();
        let resp = route(&s, "views.keywords", &params, json!(1)).await.expect("routed");
        assert_eq!(resp.result, Some(first.clone()), "served from the cache, the message not read again: {:?}", resp.error);
        std::fs::write(&eml, keyword_eml("quokka fondue meeting budget")).unwrap();
        lock(&s.search_index.db).as_ref().unwrap().execute("UPDATE messages SET body_state = 1 WHERE uid = 61", []).unwrap();
        let after = call(&s, "views.keywords", params).await;
        assert!(!terms_of(&after).contains(&"unseenword".to_owned()), "worked out again once indexed: {after}");
        assert!(terms_of(&after).contains(&"quokka".to_owned()), "{after}");
    }

    /// A message the index has no row for yet (no vault copy: On Demand) is
    /// cached too, keyed on the Message-ID the header cache lists for it: a
    /// uid reused after a mailbox reset names another message and is worked
    /// out again.
    #[tokio::test]
    async fn an_unindexed_uids_answer_is_keyed_on_the_listed_message_id() {
        let s = st();
        keyword_index(&s); // uid 99: an .eml, no index row
        let list = |message_id: &str| {
            crate::custody::with_conn(&s, |conn| {
                mailvault_core::custody::cache::save_headers(
                    conn, "a", "INBOX",
                    &json!({ "emails": [{ "uid": 99, "messageId": message_id, "flags": ["\\Seen"], "date": "Mon, 07 Sep 2026 10:00:00 +0000" }] }).to_string(),
                )
            })
            .unwrap();
        };
        list("<old@x.test>");
        let params = json!({ "accountId": "a", "mailbox": "INBOX", "uid": 99 });
        let first = call(&s, "views.keywords", params.clone()).await;
        assert!(terms_of(&first).contains(&"quokka".to_owned()), "{first}");
        let cur = mailvault_core::vault_files::cur_path(&s.data_dir, "a", "INBOX");
        let eml = cur.join(format!("99{}S.eml", mailvault_core::maildir::INFO_PREFIX));
        std::fs::remove_file(&eml).unwrap();
        let resp = route(&s, "views.keywords", &params, json!(1)).await.expect("routed");
        assert_eq!(resp.result, Some(first.clone()), "served from the cache: {:?}", resp.error);
        list("<new@x.test>");
        std::fs::write(&eml, keyword_eml("zebra crossing")).unwrap();
        let after = call(&s, "views.keywords", params).await;
        assert!(terms_of(&after).contains(&"zebra".to_owned()), "another message under the old uid: {after}");
    }

    /// Unknown, not "no keywords": the app shows nothing rather than a guess.
    #[tokio::test]
    async fn keywords_are_unavailable_without_an_index() {
        let s = st();
        let out = call(&s, "views.keywords", json!({ "accountId": "a", "mailbox": "INBOX", "uid": 1 })).await;
        assert_eq!(out, json!({ "available": false, "keywords": [] }));
    }

    /// Same convenience rule as `suggest_senders`: nothing to offer while the
    /// index is closed is not a failure.
    #[tokio::test]
    async fn suggest_terms_offers_nothing_while_the_index_is_closed() {
        let s = st();
        let out = call(&s, "views.suggest_terms", json!({ "prefix": "sta", "accounts": ["a"] })).await;
        assert_eq!(out, json!([]));
    }
}
