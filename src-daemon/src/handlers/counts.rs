//! Read-only, original-bound unread reduction. This route never resolves credentials.
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::unread_counts::{reduce_unread, UnreadInput};
use mailvault_core::{accounts_doc, custody::cache};
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashSet};
use std::sync::Arc;
use std::time::Duration;

#[cfg(test)]
static UNREAD_READ_GATE: std::sync::Mutex<Option<(
    std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>> = std::sync::Mutex::new(None);

#[cfg(test)]
pub(crate) fn pause_next_cache_read_for_test() -> (
    std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
    let (entered, observed) = std::sync::mpsc::channel();
    let (release, held) = std::sync::mpsc::channel();
    *UNREAD_READ_GATE.lock().unwrap_or_else(|e|e.into_inner())=Some((entered,held));
    (observed,release)
}

#[cfg(test)]
pub(crate) fn clear_pending_cache_read_for_test() {
    *UNREAD_READ_GATE.lock().unwrap_or_else(|e|e.into_inner())=None;
}

fn keys(value: &Value, allowed: &[&str]) -> bool {
    value.as_object().is_some_and(|map| map.keys().all(|key| allowed.contains(&key.as_str())))
}
fn id(value: Option<&Value>) -> Option<&str> {
    value?.as_str().filter(|s| !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control))
}
fn rows(value: Option<&Value>) -> bool {
    value.is_some_and(|v| v.as_array().is_some_and(|rows| rows.iter().all(|row| {
        keys(row, &["uid","flags","messageId","_accountId","_srcAccountId","_mailbox","isArchived"])
            && row.get("uid").and_then(Value::as_u64).is_some()
            && row.get("flags").is_none_or(|flags| flags.as_array().is_some_and(|a| a.iter().all(Value::is_string)))
    })))
}
fn cache_shape(cache: &Value) -> bool {
    if cache.is_null() { return true; }
    keys(cache, &["emails","totalEmails"])
        && cache.get("emails").is_none_or(|value| rows(Some(value)))
        && cache.get("totalEmails").is_none_or(|value| value.is_null() || value.is_number() || value.is_string())
}
fn projection_shape(p: &Value) -> bool {
    if !keys(p, &["archivedKeys","deleteTombstones","snoozes","autoTagRules","tagsByRow",
        "viewHiddenKeys","hideViewMail","followUps"]) { return false; }
    let Some(map) = p.as_object() else { return false; };
    for field in ["archivedKeys","deleteTombstones","viewHiddenKeys"] {
        if map.get(field).is_some_and(|v| !(v.is_null() || v.as_array().is_some_and(|a| a.iter().all(Value::is_string)))) { return false; }
    }
    if map.get("hideViewMail").is_some_and(|v| !v.is_boolean()) { return false; }
    if map.get("tagsByRow").is_some_and(|v| !v.as_object().is_some_and(|o| o.values().all(|v| v.as_array().is_some_and(|a| a.iter().all(Value::is_string))))) { return false; }
    for (field, allowed) in [
        ("snoozes", &["accountId","fromMailbox","snoozedMailbox","messageId","state","id"][..]),
        ("autoTagRules", &["tagId","enabled","inboxAction"][..]),
        ("followUps", &["id","accountId","state","sentMailbox","sentUid","seen","announced"][..]),
    ] {
        if map.get(field).is_some_and(|v| !v.as_array().is_some_and(|a| a.iter().all(|row| keys(row,allowed)))) { return false; }
    }
    true
}
fn presentation_shape(p: &Value) -> bool {
    keys(p, &["accounts","hiddenAccounts","displayNames","accountOrder"])
        && p.get("accounts").is_none_or(|v| v.as_array().is_some_and(|a| a.iter().all(|r|
            keys(r,&["id","name","email"]) && id(r.get("id")).is_some())))
        && p.get("hiddenAccounts").is_none_or(|v|v.as_object().is_some_and(|m|m.values().all(Value::is_boolean)))
        && p.get("displayNames").is_none_or(|v|v.as_object().is_some_and(|m|m.values().all(Value::is_string)))
        && p.get("accountOrder").is_none_or(|v| v.as_array().is_some_and(|a| a.iter().all(Value::is_string)))
}
fn change_affects(change: &Value, account: &str) -> bool {
    let before = change.get("before");
    let after = change.get("after");
    match change.get("kind").and_then(Value::as_str) {
        Some("snoozes") => {
            let keys = |rows: Option<&Value>| -> HashSet<String> {
                rows.and_then(Value::as_array).into_iter().flatten()
                    .filter(|row| row.get("accountId").and_then(Value::as_str)==Some(account)
                        && row.get("fromMailbox").and_then(Value::as_str)==Some("INBOX")
                        && row.get("snoozedMailbox").and_then(Value::as_str)==Some("")
                        && row.get("state").and_then(Value::as_str)==Some("snoozed"))
                    .filter_map(|row| row.get("messageId").and_then(Value::as_str)
                        .and_then(mailvault_core::compose::normalize_message_id))
                    .collect()
            };
            keys(before)!=keys(after)
        }
        Some("viewHiddenKeys") => {
            let prefix=format!("{account}|INBOX|");
            let keys = |rows: Option<&Value>| -> HashSet<String> {
                rows.and_then(Value::as_array).into_iter().flatten()
                    .filter_map(Value::as_str).filter(|key| key.starts_with(&prefix))
                    .map(str::to_owned).collect()
            };
            keys(before)!=keys(after)
        }
        _ => false,
    }
}
fn strict(value: &Value) -> Option<BTreeSet<String>> {
    let op = value.get("op")?.as_str()?;
    let common = &["op","baseline","projection","presentation"];
    let mut fields = common.to_vec();
    let mut affected = BTreeSet::new();
    match op {
        "recountRows" => fields.extend(["accountId","cache"]),
        "recountCache" => fields.extend(["accountId","preferredRows","arrivalCount","change"]),
        "shift" => fields.extend(["entries","sign","mode"]),
        "followUps" => fields.extend(["before","after"]),
        "merge" => fields.extend(["kind","observations","accountId","count"]),
        "rows" => {},
        _ => return None,
    }
    if !keys(value,&fields) || !value.get("baseline")?.as_object()?.values().all(|v| v.as_i64().is_some())
        || value.get("projection").is_some_and(|v| !projection_shape(v))
        || value.get("presentation").is_some_and(|v| !presentation_shape(v)) { return None; }
    match op {
        "recountRows" => {
            affected.insert(id(value.get("accountId"))?.to_owned());
            if !cache_shape(value.get("cache")?) { return None; }
        }
        "recountCache" => {
            affected.insert(id(value.get("accountId"))?.to_owned());
            if value.get("preferredRows").is_some_and(|v| !cache_shape(v))
                || value.get("arrivalCount").is_some_and(|v| v.as_i64().is_none_or(|n| n < 0)) { return None; }
            if value.get("change").is_some_and(|v| !keys(v,&["kind","before","after"])
                || !matches!(v.get("kind").and_then(Value::as_str),Some("snoozes"|"viewHiddenKeys"))
                || !v.get("before").is_some_and(|rows| rows.is_null() || rows.is_array())
                || !v.get("after").is_some_and(|rows| rows.is_null() || rows.is_array())
                || ["before","after"].iter().any(|field|v.get(*field).and_then(Value::as_array)
                    .is_some_and(|rows| rows.iter().any(|row| match v.get("kind").and_then(Value::as_str) {
                        Some("snoozes") => !keys(row,&["accountId","fromMailbox","snoozedMailbox","messageId","state"]),
                        Some("viewHiddenKeys") => !row.is_string(),
                        _ => true,
                    })))) { return None; }
        }
        "shift" => {
            if !matches!(value.get("sign").and_then(Value::as_i64),Some(-1|1))
                || !matches!(value.get("mode").and_then(Value::as_str),Some("unreadOnly"|"changedReadState")) { return None; }
            for item in value.get("entries")?.as_array()? {
                if !keys(item,&["accountId","mailbox","row"]) || !rows(Some(&json!([item.get("row")?]))) { return None; }
                if let Some(account) = id(item.get("accountId")) { affected.insert(account.to_owned()); }
                if item.get("mailbox")?.as_str().is_none() { return None; }
            }
        }
        "followUps" => {
            for field in ["before","after"] {
                for item in value.get(field)?.as_array()? {
                    if !keys(item,&["id","accountId","state","sentMailbox","sentUid","seen","announced"]) { return None; }
                    if let Some(account) = id(item.get("accountId")) { affected.insert(account.to_owned()); }
                }
            }
        }
        "merge" => match value.get("kind")?.as_str()? {
            "arrivals" => {
                if value.get("observations").is_some() { return None; }
                affected.insert(id(value.get("accountId"))?.to_owned());
                if value.get("count")?.as_i64().is_none() { return None; }
            }
            "forget" => {
                if value.get("observations").is_some() || value.get("count").is_some() { return None; }
                affected.insert(id(value.get("accountId"))?.to_owned());
            }
            "recounts" => {
                if value.get("accountId").is_some() || value.get("count").is_some() { return None; }
                for item in value.get("observations")?.as_array()? {
                    if !keys(item,&["accountId","cache","projection"]) || !cache_shape(item.get("cache")?)
                        || item.get("projection").is_some_and(|v| !projection_shape(v)) { return None; }
                    affected.insert(id(item.get("accountId"))?.to_owned());
                }
            }
            _ => return None,
        },
        _ => {},
    }
    Some(affected)
}

struct CacheRead {
    value: Value,
    owner: Option<mailvault_core::imap::NativeHeaderIdentity>,
    generation: u64,
}
fn read_cache(state: &DaemonState, origin: &crate::sync_observation::Origin) -> Result<CacheRead,String> {
    let account = origin.original.id();
    let (meta, owner, first_generation) = crate::custody::with_conn(state, |conn| {
        let meta = cache::load_meta(conn,account,"INBOX")?;
        let owner = cache::native_identity(conn,account,"INBOX")?;
        Ok((meta,owner,crate::custody::generation(state)))
    })?;
    #[cfg(test)]
    let gate=UNREAD_READ_GATE.lock().unwrap_or_else(|e|e.into_inner()).take();
    #[cfg(test)]
    if let Some((entered,release))=gate {
        let _=entered.send(());
        let _=release.recv_timeout(Duration::from_secs(5));
    }
    let Some(owner) = owner else { return Ok(CacheRead { value:Value::Null, owner:None, generation:first_generation }); };
    if owner.origin_hash != origin.hash { return Ok(CacheRead { value:Value::Null, owner:Some(owner), generation:first_generation }); }
    let Some(text) = meta else { return Ok(CacheRead { value:Value::Null, owner:Some(owner), generation:first_generation }); };
    let mut meta: Value = serde_json::from_str(&text).map_err(|_| "errors.bulkIdentityUncertain")?;
    let expected = meta.get("totalCached").and_then(Value::as_u64).unwrap_or(0);
    if meta.get("totalEmails").and_then(Value::as_f64).is_some_and(|n| n > expected as f64) {
        return Ok(CacheRead { value:json!({"emails":[],"totalEmails":meta["totalEmails"]}),
            owner:Some(owner), generation:first_generation });
    }
    let mut all = Vec::new();
    let mut after = 0;
    loop {
        let page = crate::custody::with_conn(state, |conn|
            cache::unread_rows_page(conn,account,"INBOX",after,256))?;
        if page.is_empty() { break; }
        after = page.last().and_then(|v| v["uid"].as_u64()).unwrap_or(0) as u32;
        let done = page.len() < 256;
        all.extend(page);
        if done { break; }
    }
    let same = crate::custody::with_conn(state, |conn| Ok(
        crate::custody::generation(state) == first_generation
            && cache::native_identity(conn,account,"INBOX")? == Some(owner.clone())
            && cache::load_meta(conn,account,"INBOX")? == Some(text.clone())
    ))?;
    if !same || all.len() as u64 != expected { return Ok(CacheRead { value:Value::Null,
        owner:Some(owner), generation:first_generation }); }
    meta["emails"] = Value::Array(all);
    Ok(CacheRead { value:meta, owner:Some(owner), generation:first_generation })
}

fn incomplete(cache: Option<&Value>) -> bool {
    let Some(rows)=cache.and_then(|v|v.get("emails")).and_then(Value::as_array) else { return true; };
    let total=cache.and_then(|v|v.get("totalEmails"))
        .and_then(|v|v.as_f64().or_else(||v.as_str().and_then(|s|s.parse::<f64>().ok())));
    total.is_some_and(|n|n>rows.len() as f64)
}

fn persisted(state: &DaemonState, value: &mut Value, accounts: &BTreeSet<String>) -> Result<(),String> {
    if value.get("op").and_then(Value::as_str)==Some("recountRows") {
        if incomplete(value.get("cache")) { return Ok(()); }
    }
    if value.get("op").and_then(Value::as_str)==Some("recountCache") {
        if incomplete(value.get("cache")) { return Ok(()); }
    }
    if !matches!(value.get("op").and_then(Value::as_str),
        Some("recountRows" | "recountCache" | "shift"))
        && !(value.get("op").and_then(Value::as_str)==Some("merge")
            && value.get("kind").and_then(Value::as_str)==Some("recounts")) { return Ok(()); }
    if value.get("op").and_then(Value::as_str)==Some("merge")
        && value.get("kind").and_then(Value::as_str)==Some("recounts")
        && value.get("observations").and_then(Value::as_array).is_some_and(|items|
            items.iter().all(|item| ["snoozes","followUps","autoTagRules","tagsByRow"].iter()
                .all(|key|item.get("projection").and_then(|p|p.get(*key)).is_some()))) { return Ok(()); }
    let need = ["snoozes","followUps","autoTagRules","tagsByRow"].iter().any(|key|
        value.get("projection").and_then(|p| p.get(*key)).is_none());
    if !need || accounts.is_empty() { return Ok(()); }
    let mut cache_snapshots=Vec::new();
    if let (Some(account),Some(cache))=(value.get("accountId").and_then(Value::as_str),value.get("cache")) {
        cache_snapshots.push((account.to_owned(),cache.clone()));
    }
    if let Some(observations)=value.get("observations").and_then(Value::as_array) {
        for item in observations {
            if let (Some(account),Some(cache))=(item.get("accountId").and_then(Value::as_str),item.get("cache")) {
                cache_snapshots.push((account.to_owned(),cache.clone()));
            }
        }
    }
    let path = state.app_dir.join("app.db");
    let db = Connection::open_with_flags(path,OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "errors.bulkIdentityUncertain".to_owned())?;
    let p = value.as_object_mut().ok_or("errors.accountsInvalid")?
        .entry("projection").or_insert_with(|| json!({}));
    let p = p.as_object_mut().ok_or("errors.accountsInvalid")?;
    if !p.contains_key("snoozes") {
        let mut out=Vec::new();
        let mut stmt=db.prepare("SELECT account_id,from_mailbox,snoozed_mailbox,message_id,state FROM snoozes WHERE state IN ('snoozed','failed') AND account_id=?1")
            .map_err(|_| "errors.bulkIdentityUncertain")?;
        for account in accounts {
            let found=stmt.query_map([account],|r|Ok(json!({"accountId":r.get::<_,String>(0)?,
                "fromMailbox":r.get::<_,String>(1)?,"snoozedMailbox":r.get::<_,String>(2)?,
                "messageId":r.get::<_,String>(3)?,"state":r.get::<_,String>(4)?})))
                .map_err(|_| "errors.bulkIdentityUncertain")?;
            for row in found { out.push(row.map_err(|_| "errors.bulkIdentityUncertain")?); }
        }
        p.insert("snoozes".into(),Value::Array(out));
    }
    if !p.contains_key("followUps") {
        let mut out=Vec::new();
        let mut stmt=db.prepare("SELECT id,account_id,state,sent_mailbox,sent_uid,seen,announced FROM follow_ups WHERE state IN ('waiting','due') AND account_id=?1")
            .map_err(|_| "errors.bulkIdentityUncertain")?;
        for account in accounts {
            let found=stmt.query_map([account],|r|Ok(json!({"id":r.get::<_,String>(0)?,
                "accountId":r.get::<_,String>(1)?,"state":r.get::<_,String>(2)?,
                "sentMailbox":r.get::<_,String>(3)?,"sentUid":r.get::<_,Option<i64>>(4)?,
                "seen":r.get::<_,bool>(5)?,"announced":r.get::<_,bool>(6)?})))
                .map_err(|_| "errors.bulkIdentityUncertain")?;
            for row in found { out.push(row.map_err(|_| "errors.bulkIdentityUncertain")?); }
        }
        p.insert("followUps".into(),Value::Array(out));
    }
    if !p.contains_key("autoTagRules") {
        let mut stmt=db.prepare("SELECT tag_id,enabled,inbox_action FROM auto_tag_rules")
            .map_err(|_| "errors.bulkIdentityUncertain")?;
        let found=stmt.query_map([],|r|Ok(json!({"tagId":r.get::<_,String>(0)?,
            "enabled":r.get::<_,bool>(1)?,"inboxAction":r.get::<_,String>(2)?})))
            .map_err(|_| "errors.bulkIdentityUncertain")?;
        let out=found.collect::<Result<Vec<_>,_>>().map_err(|_| "errors.bulkIdentityUncertain")?;
        p.insert("autoTagRules".into(),Value::Array(out));
    }
    if !p.contains_key("tagsByRow") {
        let mut map=Map::new();
        let mut stmt=db.prepare("SELECT tag_id FROM tag_assignments WHERE account_id=?1 AND msg_key=?2")
            .map_err(|_| "errors.bulkIdentityUncertain")?;
        let mut visit = |account: &str, cache: &Value| -> Result<(),String> {
            for row in cache.get("emails").and_then(Value::as_array).into_iter().flatten() {
                let Some(uid)=row.get("uid").and_then(Value::as_u64).and_then(|n|u32::try_from(n).ok()) else { continue; };
                let key=mailvault_core::app_db::identity::msg_key(row.get("messageId").and_then(Value::as_str),"INBOX",uid);
                let tags=stmt.query_map(params![account,key],|r|r.get::<_,String>(0))
                    .map_err(|_| "errors.bulkIdentityUncertain")?
                    .collect::<Result<Vec<_>,_>>().map_err(|_| "errors.bulkIdentityUncertain")?;
                map.insert(format!("{account}|INBOX|{uid}"),json!(tags));
            }
            Ok(())
        };
        for (account,cache) in &cache_snapshots { visit(account,cache)?; }
        p.insert("tagsByRow".into(),Value::Object(map));
    }
    Ok(())
}

pub(crate) async fn route(state: &Arc<DaemonState>, params: Value, id: Value) -> RpcResponse {
    let Some(affected)=strict(&params) else {
        return RpcResponse::error(id,ipc::INVALID_PARAMS,"errors.accountsInvalid");
    };
    let app_dir=state.app_dir.clone();
    let listing=match tokio::task::spawn_blocking(move ||
        accounts_doc::list(&accounts_doc::shared(&app_dir))).await {
        Ok(Ok(listing)) => listing,
        Err(_) => return RpcResponse::error(id,ipc::INTERNAL_ERROR,"errors.bulkIdentityUncertain"),
        Ok(Err(_)) => return RpcResponse::error(id,ipc::INTERNAL_ERROR,"errors.bulkIdentityUncertain"),
    };
    let present=accounts_doc::authoritative_ids(&listing.accounts);
    let forget=params.get("op").and_then(Value::as_str)==Some("merge")
        && params.get("kind").and_then(Value::as_str)==Some("forget");
    if affected.iter().any(|account| present.contains(account)==forget) {
        return RpcResponse::error(id,ipc::INVALID_PARAMS,"errors.accountsInvalid");
    }
    let mut origins=Vec::new();
    for account in &affected {
        if forget { break; }
        let original=match state.account_lifecycle.capture(account) {
            Ok(v)=>v,
            Err(_)=>return RpcResponse::error(id,ipc::INTERNAL_ERROR,"errors.bulkIdentityChanged"),
        };
        let origin=match crate::sync_observation::origin(state,original).await {
            Ok(v)=>v,
            Err(error)=>return RpcResponse::error(id,ipc::INTERNAL_ERROR,error),
        };
        origins.push(origin);
    }
    let worker_state=Arc::clone(state);
    let job=async move {
        tokio::task::spawn_blocking(move || {
            let state=worker_state;
            let mut value=params;
            if value.get("presentation").is_none() {
                let listing=accounts_doc::list(&accounts_doc::shared(&state.app_dir))
                    .map_err(|_| "errors.bulkIdentityUncertain")?;
                let settings=mailvault_core::settings_doc::SettingsDoc::shared(&state.app_dir).read()?;
                let accounts:Vec<Value>=listing.accounts.iter().filter_map(|row|row.get("id")
                    .and_then(Value::as_str).map(|id|json!({"id":id,
                        "name":row.get("name").and_then(Value::as_str).unwrap_or(""),
                        "email":row.get("email").and_then(Value::as_str).unwrap_or("")}))).collect();
                value["presentation"]=json!({"accounts":accounts,
                    "hiddenAccounts":settings.get("hiddenAccounts").cloned().unwrap_or(json!({})),
                    "displayNames":settings.get("displayNames").cloned().unwrap_or(json!({})),
                    "accountOrder":settings.get("accountOrder").cloned().unwrap_or(json!([]))});
            }
            // Keep the original source captured above. One later cache generation
            // may be a concurrent write by that same owner, so re-read once
            // before answering; raw shifts and other operations run once.
            let original=value;
            let attempts=if original.get("op").and_then(Value::as_str)==Some("recountCache") { 2 } else { 1 };
            for attempt in 0..attempts {
                let mut value=original.clone();
                let mut cache_proof=None;
                let mut recount_source=None;
                if value.get("op").and_then(Value::as_str)==Some("recountCache") {
                    let account=value["accountId"].as_str().ok_or("errors.accountsInvalid")?;
                    let origin=origins.iter().find(|o|o.original.id()==account).ok_or("errors.bulkIdentityChanged")?;
                    let affected_by_change=value.get("change").is_none_or(|change|change_affects(change,account));
                    let cache=if !affected_by_change { Value::Null } else { match value.get("preferredRows") {
                        Some(preferred) if preferred.get("emails").and_then(Value::as_array)
                            .is_some_and(|rows| !preferred.get("totalEmails").and_then(Value::as_f64)
                                .is_some_and(|n|n>rows.len() as f64)) => {
                            let proof=crate::custody::with_conn(&state,|conn| Ok((
                                cache::native_identity(conn,account,"INBOX")?,crate::custody::generation(&state))))?;
                            cache_proof=Some((account.to_owned(),proof.0,proof.1));
                            preferred.clone()
                        },
                        _ => {
                            let read=read_cache(&state,origin)?;
                            cache_proof=Some((account.to_owned(),read.owner,read.generation));
                            read.value
                        },
                    }};
                    recount_source=Some(if !incomplete(Some(&cache)) { "complete" }
                        else if value.get("arrivalCount").and_then(Value::as_i64).is_some_and(|n|n>0)
                            { "arrivalFallback" } else { "none" });
                    value["cache"]=cache;
                }
                persisted(&state,&mut value,&affected)?;
                let mut leases=Vec::new();
                for origin in &origins {
                    leases.push(crate::sync_observation::source_lease(&state,&origin.original,&origin.hash)?);
                    let _commit=state.account_lifecycle.try_commit(std::slice::from_ref(&origin.original))
                        .map_err(|_| "errors.bulkIdentityChanged")?;
                }
                if let Some((account,owner,generation))=cache_proof {
                    let (current_owner,current_generation)=crate::custody::with_conn(&state,|conn| Ok((
                        cache::native_identity(conn,&account,"INBOX")?,
                        crate::custody::generation(&state))))?;
                    // A new owner or retired original source is never a retry of
                    // the account named by this request.
                    if current_owner!=owner { return Err("errors.bulkIdentityChanged".to_owned()); }
                    if current_generation!=generation {
                        if attempt==0 { continue; }
                        return Err("errors.bulkIdentityChanged".to_owned());
                    }
                }
                let mut answer=json!(reduce_unread(UnreadInput(value)));
                if let Some(source)=recount_source { answer["recountSource"]=json!(source); }
                return Ok::<Value,String>(answer);
            }
            Err("errors.bulkIdentityChanged".to_owned())
        }).await.map_err(|_| "errors.bulkIdentityUncertain".to_owned())?
    };
    let result=match state.sync_observation.spawn_job(job) {
        Ok(receiver)=>tokio::time::timeout(Duration::from_secs(30),receiver).await,
        Err(error)=>return RpcResponse::error(id,ipc::INTERNAL_ERROR,error),
    };
    match result {
        Ok(Ok(Ok(value)))=>RpcResponse::success(id,value),
        Ok(Ok(Err(error)))=>RpcResponse::error(id,ipc::INTERNAL_ERROR,error),
        _=>RpcResponse::error(id,ipc::INTERNAL_ERROR,"errors.syncUnavailable"),
    }
}
