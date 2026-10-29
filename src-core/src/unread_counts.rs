//! Pure unread projection. Storage and source validation belong to the route.
use crate::compose::normalize_message_id;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug)]
pub struct UnreadInput(pub Value);

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct UnreadOutput {
    pub counts: Map<String, Value>,
    pub rows: Vec<Value>,
    pub total: i64,
    pub wrote: bool,
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        _ => true,
    }
}
fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> { v.get(key).and_then(Value::as_str) }
fn number(value: Option<&Value>) -> i64 { value.and_then(Value::as_i64).unwrap_or(0) }
fn strings(value: Option<&Value>) -> HashSet<String> {
    value.and_then(Value::as_array).map(|v| v.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default()
}
fn array(value: Option<&Value>) -> &[Value] { value.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) }
fn projection<'a>(input: &'a Value, key: &str) -> Option<&'a Value> { input.get("projection").and_then(|p| p.get(key)) }
fn due_followups(rows: &[Value]) -> HashMap<String, i64> {
    let mut by_account = HashMap::new();
    for row in rows {
        if text(row, "state") != Some("due") || !truthy(row.get("sentMailbox"))
            || row.get("sentUid").and_then(Value::as_i64).is_none() || truthy(row.get("seen")) { continue; }
        if let Some(id) = text(row, "accountId") {
            *by_account.entry(id.to_owned()).or_insert(0) += 1;
        }
    }
    by_account
}
fn identity(row: &Value, active: &str) -> Option<(String, String, String)> {
    let account = text(row, "_accountId").filter(|s| !s.is_empty())
        .or_else(|| text(row, "_srcAccountId").filter(|s| !s.is_empty()))
        .unwrap_or(active);
    let mailbox = text(row, "_mailbox").filter(|s| !s.is_empty())
        .or_else(|| (account == active).then_some("INBOX"))?;
    if account.is_empty() || mailbox == "UNIFIED" { return None; }
    let uid = row.get("uid")?.as_u64()?.to_string();
    Some((account.to_owned(), mailbox.to_owned(), uid))
}
fn shown(input: &Value, account: &str, row: &Value, tombstones: bool, forced_unseen: bool) -> bool {
    let p = input.get("projection").unwrap_or(&Value::Null);
    let flags = array(row.get("flags"));
    let has_flag = |name: &str| flags.iter().any(|f| f.as_str() == Some(name));
    if !forced_unseen && has_flag("\\Seen") { return false; }
    let row_id = identity(row, account);
    let archived = row.get("isArchived").and_then(Value::as_bool).unwrap_or_else(|| {
        row_id.as_ref().is_some_and(|(a,m,u)| strings(p.get("archivedKeys")).contains(&format!("{a}:{m}:{u}")))
    });
    if !archived && has_flag("\\Deleted") { return false; }
    let hidden_tags: HashSet<String> = array(p.get("autoTagRules")).iter()
        .filter(|r| truthy(r.get("enabled")) && text(r,"inboxAction") == Some("hide"))
        .filter_map(|r| text(r,"tagId").map(str::to_owned)).collect();
    if !hidden_tags.is_empty() && text(row,"_mailbox").filter(|s| !s.is_empty()).unwrap_or("INBOX") == "INBOX" {
        let key = format!("{}|INBOX|{}", text(row,"_accountId").filter(|s| !s.is_empty()).unwrap_or(account),
            row.get("uid").and_then(Value::as_u64).map(|u| u.to_string()).unwrap_or_else(|| "undefined".into()));
        if array(p.get("tagsByRow").and_then(|tags| tags.get(&key))).iter()
            .filter_map(Value::as_str).any(|tag| hidden_tags.contains(tag)) { return false; }
    }
    if let Some((a,m,u)) = &row_id {
        let key = format!("{a}|{m}|{u}");
        if tombstones && strings(p.get("deleteTombstones")).contains(&key) { return false; }
        if truthy(p.get("hideViewMail")) && strings(p.get("viewHiddenKeys")).contains(&key) { return false; }
    }
    if let Some(message_id) = text(row, "messageId").filter(|s| !s.is_empty()).and_then(normalize_message_id) {
        let a = text(row,"_accountId").filter(|s| !s.is_empty()).unwrap_or(account);
        let m = text(row,"_mailbox").filter(|s| !s.is_empty()).unwrap_or("INBOX");
        if array(p.get("snoozes")).iter().any(|s| text(s,"accountId") == Some(a)
            && text(s,"fromMailbox") == Some(m) && text(s,"snoozedMailbox") == Some("")
            && text(s,"state") == Some("snoozed")
            && text(s,"messageId").and_then(normalize_message_id).as_deref() == Some(message_id.as_str())) { return false; }
    }
    true
}
fn complete(cache: &Value) -> Option<&[Value]> {
    let rows = cache.get("emails")?.as_array()?;
    let total = cache.get("totalEmails");
    let too_many = match total {
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n > rows.len() as f64),
        Some(Value::String(s)) => s.parse::<f64>().is_ok_and(|n| n > rows.len() as f64),
        _ => false,
    };
    (!too_many).then_some(rows)
}
fn count_rows(input: &Value, account: &str, cache: &Value) -> Option<i64> {
    let rows = complete(cache)?;
    let reminder = due_followups(array(projection(input,"followUps"))).get(account).copied().unwrap_or(0);
    Some(rows.iter().filter(|row| shown(input, account, row, true, false)).count() as i64 + reminder)
}
fn update(counts: &mut Map<String, Value>, id: &str, value: i64) { counts.insert(id.to_owned(), json!(value)); }
fn presentation(input: &Value, counts: &Map<String, Value>) -> (Vec<Value>, i64) {
    let present = input.get("presentation").unwrap_or(&Value::Null);
    let accounts = array(present.get("accounts"));
    let hidden = present.get("hiddenAccounts");
    let names = present.get("displayNames");
    let order = array(present.get("accountOrder"));
    let mut positions = HashMap::<&str, usize>::new();
    for (i, id) in order.iter().filter_map(Value::as_str).enumerate() { positions.insert(id, i); }
    let mut indexed: Vec<(usize, &Value)> = accounts.iter().enumerate().collect();
    indexed.sort_by_key(|(_, a)| text(a,"id").and_then(|id| positions.get(id).copied()).unwrap_or(usize::MAX));
    let mut rows = Vec::new();
    let mut total = 0;
    for (_, account) in indexed {
        let Some(id) = text(account,"id") else { continue; };
        if truthy(hidden.and_then(|h| h.get(id))) { continue; }
        let label = names.and_then(|n| n.get(id)).and_then(Value::as_str).filter(|s| !s.is_empty())
            .or_else(|| text(account,"name").filter(|s| !s.is_empty()))
            .or_else(|| text(account,"email")).unwrap_or("");
        let unread = number(counts.get(id));
        total += unread;
        rows.push(json!({"id":id,"label":label,"unread":unread}));
    }
    (rows,total)
}

pub fn reduce_unread(input: UnreadInput) -> UnreadOutput {
    let value = input.0;
    let mut counts = value.get("baseline").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut wrote = false;
    match text(&value,"op").unwrap_or("") {
        "recountRows" | "recountCache" => {
            if let Some(id) = text(&value,"accountId") {
                if let Some(n) = value.get("cache").and_then(|cache| count_rows(&value,id,cache)) {
                    update(&mut counts,id,n); wrote = true;
                } else if let Some(n) = value.get("arrivalCount").and_then(Value::as_i64).filter(|n| *n > 0) {
                    let next = number(counts.get(id)) + n; update(&mut counts,id,next); wrote = true;
                }
            }
        }
        "shift" => {
            let sign = number(value.get("sign"));
            let unread_only = text(&value,"mode") == Some("unreadOnly");
            let mut deltas = HashMap::<String,i64>::new();
            for entry in array(value.get("entries")) {
                let Some(id) = text(entry,"accountId").filter(|s| !s.is_empty()) else { continue; };
                if text(entry,"mailbox") != Some("INBOX") { continue; }
                let row = entry.get("row").unwrap_or(&Value::Null);
                if unread_only && array(row.get("flags")).iter().any(|f| f.as_str() == Some("\\Seen")) { continue; }
                if shown(&value,id,row,false,true) { *deltas.entry(id.to_owned()).or_insert(0) += sign; }
            }
            for (id,delta) in deltas { let next = (number(counts.get(&id))+delta).max(0); update(&mut counts,&id,next); wrote=true; }
        }
        "followUps" => {
            let before = array(value.get("before"));
            let after = array(value.get("after"));
            let known: HashSet<&str> = before.iter().filter_map(|r| text(r,"id")).collect();
            let mut before_rows = before.to_vec();
            before_rows.extend(after.iter().filter(|r| text(r,"id").is_some_and(|id| !known.contains(id))
                && truthy(r.get("announced"))).cloned());
            let old = due_followups(&before_rows);
            let new = due_followups(after);
            for id in old.keys().chain(new.keys()).collect::<HashSet<_>>() {
                let delta = new.get(id).copied().unwrap_or(0) - old.get(id).copied().unwrap_or(0);
                if delta != 0 { let next = (number(counts.get(id.as_str()))+delta).max(0); update(&mut counts,id,next); wrote=true; }
            }
        }
        "merge" => match text(&value,"kind") {
            Some("arrivals") => {
                if let Some(id) = text(&value,"accountId") {
                    let n = number(value.get("count"));
                    let next = number(counts.get(id))+n; update(&mut counts,id,next); wrote=true;
                }
            }
            Some("forget") => {
                if let Some(id) = text(&value,"accountId") { counts.remove(id); wrote=true; }
            }
            Some("recounts") => {
                wrote = true;
                for item in array(value.get("observations")) {
                    let Some(id) = text(item,"accountId") else { continue; };
                    let mut observation = item.clone();
                    if let Some(obj) = observation.as_object_mut() {
                        if !obj.contains_key("projection") { obj.insert("projection".into(), value.get("projection").cloned().unwrap_or(Value::Null)); }
                    }
                    if let Some(n) = item.get("cache").and_then(|cache| count_rows(&observation,id,cache)) {
                        update(&mut counts,id,n); wrote=true;
                    }
                }
            }
            _ => {}
        }
        _ => {}
    }
    let (rows,total)=presentation(&value,&counts);
    UnreadOutput { counts, rows, total, wrote }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_cache_arrivals_apply_once_and_complete_cache_suppresses_fallback() {
        let request=|cache:Value| json!({"op":"recountCache","accountId":"a",
            "cache":cache,"arrivalCount":2,"baseline":{"a":7,"b":5},
            "projection":{"followUps":[]},"presentation":{"accounts":[
                {"id":"a","name":"Alpha"},{"id":"b","name":"Beta"}]}});
        let partial=reduce_unread(UnreadInput(request(json!({"emails":[{"uid":1,"flags":[]}],
            "totalEmails":500}))));
        assert_eq!(partial.counts,json!({"a":9,"b":5}).as_object().unwrap().clone());
        assert_eq!(partial.total,14);
        assert!(partial.wrote);
        let complete=reduce_unread(UnreadInput(request(json!({"emails":[{"uid":1,"flags":[]}],
            "totalEmails":1}))));
        assert_eq!(complete.counts,json!({"a":1,"b":5}).as_object().unwrap().clone());
        assert_eq!(complete.total,6);
        assert!(complete.wrote);
        let unavailable=reduce_unread(UnreadInput(json!({"op":"recountCache","accountId":"a",
            "cache":null,"baseline":{"a":7,"b":5},"presentation":{"accounts":[]}})));
        assert_eq!(unavailable.counts,json!({"a":7,"b":5}).as_object().unwrap().clone());
        assert!(!unavailable.wrote);
    }

    #[test]
    fn arrival_then_negative_shift_at_zero_preserves_submitted_order() {
        let arrival = |baseline: Value| reduce_unread(UnreadInput(json!({
            "op":"merge","kind":"arrivals","accountId":"a","count":1,
            "baseline":baseline,"presentation":{"accounts":[]}
        })));
        let shift = |baseline: Value| reduce_unread(UnreadInput(json!({
            "op":"shift","entries":[{"accountId":"a","mailbox":"INBOX",
                "row":{"uid":1,"flags":[]}}],"sign":-1,"mode":"changedReadState",
            "baseline":baseline,"presentation":{"accounts":[]},"projection":{}
        })));
        let first_arrival = arrival(json!({"a":0,"b":5}));
        let then_shift = shift(json!(first_arrival.counts));
        assert_eq!(then_shift.counts, json!({"a":0,"b":5}).as_object().unwrap().clone());
        let first_shift = shift(json!({"a":0,"b":5}));
        let then_arrival = arrival(json!(first_shift.counts));
        assert_eq!(then_arrival.counts, json!({"a":1,"b":5}).as_object().unwrap().clone());
    }

    fn unmark(value: &mut Value) {
        match value {
            Value::Object(map) => {
                map.retain(|_, value| value.get("$undefined") != Some(&Value::Bool(true)));
                for value in map.values_mut() { unmark(value); }
            }
            Value::Array(rows) => for row in rows { unmark(row); },
            _ => {}
        }
    }

    #[test]
    fn frozen_old_js_unread_decisions_match_all_sixty_three_direct_cases() {
        let fixture: Value = serde_json::from_str(include_str!("../tests/fixtures/unread-counts-cases.json")).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 63);
        for case in cases {
            let mut seed = case["input"]["seed"].clone();
            unmark(&mut seed);
            let settings = &seed["settings"];
            let mut counts = settings.get("unreadPerAccount").and_then(Value::as_object).cloned()
                .unwrap_or_else(|| json!({"a":7,"b":5}).as_object().unwrap().clone());
            let projection = json!({
                "archivedKeys":seed.get("archivedKeys").cloned().unwrap_or(json!([])),
                "deleteTombstones":seed.get("deleteTombstones").cloned().unwrap_or(json!([])),
                "snoozes":seed.get("snoozes").cloned().unwrap_or(json!([])),
                "autoTagRules":seed.get("autoTagRules").cloned().unwrap_or(json!([])),
                "tagsByRow":seed.get("tagsByRow").cloned().unwrap_or(json!({})),
                "viewHiddenKeys":seed.get("viewHiddenKeys").cloned().unwrap_or(Value::Null),
                "hideViewMail":settings.get("hideViewMail").cloned().unwrap_or(json!(false)),
                "followUps":seed.get("followUps").cloned().unwrap_or(json!([])),
            });
            for (step, expected) in case["input"]["steps"].as_array().unwrap().iter()
                .zip(case["output"]["steps"].as_array().unwrap()) {
                let mut step = step.clone();
                unmark(&mut step);
                let op = step["op"].as_str().unwrap();
                let mut request = json!({"baseline":counts,"projection":projection,
                    "presentation":{"accounts":[
                        {"id":"a","name":"Alpha","email":"a@example.test"},
                        {"id":"b","name":"Beta","email":"b@example.test"}],
                        "hiddenAccounts":settings.get("hiddenAccounts").cloned().unwrap_or(json!({})),
                        "displayNames":settings.get("displayNames").cloned().unwrap_or(json!({})),
                        "accountOrder":settings.get("accountOrder").cloned().unwrap_or(json!([]))}});
                match op {
                    "recount" => { request["op"]=json!("recountRows"); request["accountId"]=json!("a");
                        request["cache"]=step["cache"].clone(); }
                    "shift" => { request["op"]=json!("shift"); request["entries"]=step["entries"].clone();
                        request["sign"]=step["sign"].clone();
                        request["mode"]=json!(if step.get("unreadOnly").and_then(Value::as_bool)==Some(true)
                            {"unreadOnly"}else{"changedReadState"}); }
                    "followUps" => { request["op"]=json!("followUps"); request["before"]=step["before"].clone();
                        request["after"]=step["after"].clone(); }
                    "arrivals" => { request["op"]=json!("merge"); request["kind"]=json!("arrivals");
                        request["accountId"]=step["accountId"].clone(); request["count"]=step["count"].clone(); }
                    "forget" => { request["op"]=json!("merge"); request["kind"]=json!("forget");
                        request["accountId"]=step["accountId"].clone(); }
                    "merge" => { request["op"]=json!("merge"); request["kind"]=json!("recounts");
                        request["observations"]=Value::Array(step["measured"].as_object().unwrap().iter()
                            .map(|(id,n)| json!({"accountId":id,"cache":{"emails":(0..n.as_u64().unwrap())
                                .map(|uid|json!({"uid":uid+1,"flags":[]})).collect::<Vec<_>>(),
                                "totalEmails":n},"projection":projection})).collect()); }
                    "rows" => { request["op"]=json!("rows");
                        if let Some(accounts)=step.get("accounts") { request["presentation"]["accounts"]=accounts.clone(); } }
                    _ => panic!("unknown oracle operation"),
                }
                let output=reduce_unread(UnreadInput(request));
                assert_eq!(Value::Object(output.counts.clone()),expected["counts"],"{} {op}",case["id"]);
                if op=="rows" {
                    assert_eq!(json!(output.rows),expected["result"]["rows"],"{} rows",case["id"]);
                    assert_eq!(json!(output.total),expected["result"]["total"],"{} total",case["id"]);
                }
                if op=="recount" { assert_eq!(output.wrote,expected["result"]["wrote"],"{} wrote",case["id"]); }
                counts=output.counts;
            }
            assert_eq!(Value::Object(counts),case["output"]["finalCounts"],"{} final",case["id"]);
        }
    }
}
