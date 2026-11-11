//! `people.*` RPCs: contacts. Thin wrappers over `mailvault_core::people`;
//! every database call runs on a blocking thread through `custody::with_conn`.
use super::common::done;
use super::people_scan::{all_proposals, all_senders, all_totals, review_candidates, seen_contacts};
use crate::ipc::RpcResponse;
use crate::state::DaemonState;
use mailvault_core::people::{correspondence as corr, journal, merge, message_addr, seen, senders, store, suggest};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) async fn db<T: Serialize + Send + 'static>(
    state: &Arc<DaemonState>,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, String> + Send + 'static,
) -> Result<Value, String> {
    let state = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        crate::custody::with_conn(&state, f).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// One custody call on a blocking thread. Every call here holds the single
/// custody lock for the length of `f`, so `f` must be a small unit of work.
pub(crate) async fn blocking_db<T: Send + 'static>(
    state: &Arc<DaemonState>,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let state = Arc::clone(state);
    tokio::task::spawn_blocking(move || crate::custody::with_conn(&state, f))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

/// The addresses `people.messages` reads: a saved contact's, or one unsaved sender's.
fn message_addresses(c: &rusqlite::Connection, id: Option<&str>, address: Option<&str>) -> Result<Vec<String>, String> {
    match (id, address) {
        (Some(id), _) => {
            let card = store::get_card(c, id)?.ok_or_else(|| "E_NOT_FOUND: person".to_string())?;
            Ok(store::card_addresses(&card))
        }
        (None, Some(a)) => message_addr::normalize(a).map(|a| vec![a]).ok_or_else(|| "E_INVALID: not an email address".to_string()),
        (None, None) => Err("E_INVALID: missing id or address".to_string()),
    }
}

pub(crate) fn str_param(p: &Value, k: &str) -> Result<String, String> {
    p.get(k).and_then(Value::as_str).map(str::to_string).ok_or_else(|| format!("E_INVALID: missing {k}"))
}
pub(crate) fn opt_str(p: &Value, k: &str) -> Option<String> {
    p.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}
pub(crate) fn strings(p: &Value, k: &str) -> Vec<String> {
    p.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default()
}
pub(crate) fn num(p: &Value, k: &str, default: usize) -> usize {
    p.get(k).and_then(Value::as_u64).map(|n| n as usize).unwrap_or(default)
}
fn own(p: &Value) -> Vec<String> {
    strings(p, "ownAddresses").iter().filter_map(|a| mailvault_core::people::message_addr::normalize(a)).collect()
}
use mailvault_core::clock::now_ms;

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    if !method.starts_with("people.") {
        return None;
    }
    let p = params.clone();
    let res: Result<Value, String> = match method {
        "people.list" => {
            let q = opt_str(&p, "query");
            let sort = store::Sort::parse(&opt_str(&p, "sort").unwrap_or_default());
            let vip = p.get("vipOnly").and_then(Value::as_bool).unwrap_or(false);
            let (limit, offset) = (num(&p, "limit", 50), num(&p, "offset", 0));
            // sorting by total or last contact needs per-address totals: paged, one lock per page
            let totals = if sort == store::Sort::Name { Ok(None) } else { all_totals(state).await.map(Some) };
            match totals {
                Ok(totals) => {
                    db(state, move |c| {
                        let (items, total) = store::list_with_totals(c, q.as_deref(), vip, sort, limit, offset, totals.as_ref())?;
                        let ready = mailvault_core::people::message_addr::backfill_done(c);
                        Ok(json!({"items": items, "total": total, "indexReady": ready}))
                    })
                    .await
                }
                Err(e) => Err(e),
            }
        }
        "people.get" => match str_param(&p, "id") {
            Ok(pid) => db(state, move |c| store::get_card(c, &pid)?.ok_or_else(|| "E_NOT_FOUND: person".to_string())).await,
            Err(e) => Err(e),
        },
        "people.stats" => {
            let (ids, addresses, own) = (strings(&p, "ids"), strings(&p, "addresses"), own(&p));
            db(state, move |c| {
                let mut out = serde_json::Map::new();
                for id in ids {
                    if let Some(card) = store::get_card(c, &id)? {
                        let st = corr::stats(c, &store::card_addresses(&card), &own, None)?;
                        out.insert(id, serde_json::to_value(st).map_err(|e| e.to_string())?);
                    }
                }
                // an unsaved sender is keyed by its own address; ids never contain '@'
                for address in addresses.iter().filter_map(|a| message_addr::normalize(a)) {
                    let st = corr::stats(c, std::slice::from_ref(&address), &own, None)?;
                    out.insert(address, serde_json::to_value(st).map_err(|e| e.to_string())?);
                }
                Ok(Value::Object(out))
            })
            .await
        }
        "people.messages" => {
            let (id, address) = (opt_str(&p, "id"), opt_str(&p, "address"));
            let own = own(&p);
            let limit = num(&p, "limit", 50).min(200);
            let after: Option<corr::Cursor> = p.get("after").and_then(|v| serde_json::from_value(v.clone()).ok());
            let (account, direction, text) = (opt_str(&p, "accountId"), opt_str(&p, "direction"), opt_str(&p, "text"));
            let (from_ms, to_ms) = (p.get("fromMs").and_then(Value::as_i64), p.get("toMs").and_then(Value::as_i64));
            db(state, move |c| {
                let addresses = message_addresses(c, id.as_deref(), address.as_deref())?;
                let f = corr::MsgFilter { account: account.as_deref(), direction: direction.as_deref(), from_ms, to_ms, text: text.as_deref() };
                let items = corr::messages(c, &addresses, &own, &f, after.as_ref(), limit)?;
                let next = (items.len() == limit).then(|| items.last()).flatten().map(|r| corr::Cursor {
                    sort_ms: r.sort_ms,
                    account_id: r.account_id.clone(),
                    mailbox_path: r.mailbox_path.clone(),
                    uid: r.uid,
                });
                Ok(json!({"items": items, "next": next}))
            })
            .await
        }
        "people.senders" => {
            let (q, own) = (opt_str(&p, "query"), own(&p));
            let sort = store::Sort::parse(&opt_str(&p, "sort").unwrap_or_default());
            let (limit, offset) = (num(&p, "limit", 50).min(200), num(&p, "offset", 0));
            match all_senders(state, own).await {
                Ok(pool) => {
                    let (items, total) = senders::pick(pool, q.as_deref(), sort, offset, limit);
                    db(state, move |c| Ok(json!({"items": items, "total": total, "indexReady": message_addr::backfill_done(c)}))).await
                }
                Err(e) => Err(e),
            }
        }
        "people.owners" => {
            let addresses: Vec<String> = strings(&p, "addresses").iter().filter_map(|a| message_addr::normalize(a)).collect();
            db(state, move |c| {
                let owned = senders::owners(c, &addresses)?;
                Ok(owned.into_iter().map(|(a, (id, vip))| (a, json!({"personId": id, "favorite": vip}))).collect::<serde_json::Map<_, _>>())
            })
            .await
        }
        "people.suggest" => {
            let (q, own, acct, limit) = (opt_str(&p, "query").unwrap_or_default(), own(&p), opt_str(&p, "fromAccountId"), num(&p, "limit", 8).min(50));
            db(state, move |c| suggest::suggest(c, &q, &own, acct.as_deref(), limit, now_ms())).await
        }
        "people.contacts.top" => {
            let (ids, own, acct, limit) = (strings(&p, "accountIds"), own(&p), opt_str(&p, "accountId"), num(&p, "limit", 50).min(200));
            seen_contacts(state, ids).await.and_then(|per| {
                let all = seen::merge(&per, &own);
                serde_json::to_value(seen::top(&all, acct.as_deref(), limit)).map_err(|e| e.to_string())
            })
        }
        "people.contacts.search" => {
            let (ids, own, limit) = (strings(&p, "accountIds"), own(&p), num(&p, "limit", 8).min(50));
            let (q, boost) = (opt_str(&p, "query").unwrap_or_default(), opt_str(&p, "boostAccountId"));
            seen_contacts(state, ids).await.and_then(|per| {
                let all = seen::merge(&per, &own);
                serde_json::to_value(seen::search(&all, &q, boost.as_deref(), limit)).map_err(|e| e.to_string())
            })
        }
        "people.contacts.names" => {
            let ids = strings(&p, "accountIds");
            seen_contacts(state, ids).await.and_then(|per| serde_json::to_value(seen::names(&per)).map_err(|e| e.to_string()))
        }
        "people.review.list" => {
            let (own, limit) = (own(&p), num(&p, "limit", 100).min(500));
            review_candidates(state, own, limit).await.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "people.journal" => {
            let limit = num(&p, "limit", 30);
            db(state, move |c| journal::recent(c, limit)).await
        }
        "people.proposals" => all_proposals(state).await.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "people.merge_preview" => match (strings(&p, "ids"), str_param(&p, "keepId")) {
            (ids, Ok(keep)) => db(state, move |c| merge::preview(c, &ids, &keep)).await,
            (_, Err(e)) => Err(e),
        },
        _ => return super::people_write::route(state, method, &p, id).await,
    };
    Some(done(id, res))
}

#[cfg(test)]
mod tests {
    use crate::test_support::handle_request_for_test;
    use crate::state::DaemonState;
    use serde_json::{json, Value};
    use std::sync::Arc;

    async fn call(state: &Arc<DaemonState>, method: &str, params: Value) -> Value {
        let resp = handle_request_for_test(state, method, params).await;
        serde_json::to_value(resp).unwrap()
    }
    fn state(ok: bool) -> (tempfile::TempDir, Arc<DaemonState>) {
        let dir = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), ok);
        s.seed_accounts_for_test(&["a1", "a2"]);
        (dir, s)
    }

    #[tokio::test]
    async fn the_route_is_reachable_through_the_servers_dispatch() {
        let (_d, state) = state(true);
        let v = call(&state, "people.list", json!({})).await;
        assert!(!v.to_string().contains("Unknown method"), "{v}");
    }

    #[tokio::test]
    async fn list_on_an_empty_vault_is_empty_and_reports_index_state() {
        let (_d, state) = state(true);
        let v = call(&state, "people.list", json!({})).await;
        assert_eq!(v["result"]["total"], 0);
        assert!(v["result"]["indexReady"].is_boolean());
    }

    #[tokio::test]
    async fn a_paged_list_by_total_does_not_wait_on_its_own_foreground_marker() {
        let (_d, state) = state(true);
        let n = 520; // two totals pages of 500 addresses
        crate::custody::with_conn(&state, |c| {
            for i in 0..n {
                let a = format!("p{i:04}@x.io");
                mailvault_core::people::store::create_person(c, &mailvault_core::people::store::NewPerson { display_name: format!("P{i}"), emails: vec![a.clone()], ..Default::default() })?;
                mailvault_core::people::message_addr::index_row(c, "acc", "INBOX", i as u32 + 1, 1000, &json!({"uid": i + 1, "from": {"address": a}}))?;
            }
            Ok(())
        })
        .unwrap();
        let t = std::time::Instant::now();
        let v = call(&state, "people.list", json!({"sort": "total", "limit": 5})).await;
        assert_eq!(v["result"]["total"], n);
        assert!(t.elapsed() < std::time::Duration::from_millis(350), "waited on itself: {:?}", t.elapsed());
    }

    #[tokio::test]
    async fn get_of_an_unknown_id_is_not_found() {
        let (_d, state) = state(true);
        let v = call(&state, "people.get", json!({"id": "nope"})).await;
        assert!(v.to_string().contains("E_NOT_FOUND"), "{v}");
    }

    #[tokio::test]
    async fn a_missing_vault_refuses_people_calls() {
        let (_d, state) = state(false);
        let v = call(&state, "people.list", json!({})).await;
        assert!(v.to_string().contains("Mail storage folder is not available"), "{v}");
    }

    async fn save(state: &Arc<DaemonState>, account: &str, mailbox: &str, emails: Value) {
        let data = json!({ "emails": emails }).to_string();
        let v = call(state, "save_email_cache", json!({"accountId": account, "mailbox": mailbox, "data": data})).await;
        assert!(v.get("error").is_none(), "{v}");
    }
    fn mail(uid: u32, date: &str, from: (&str, &str), to: (&str, &str)) -> Value {
        json!({"uid": uid, "date": date, "from": {"name": from.0, "address": from.1}, "to": [{"name": to.0, "address": to.1}], "cc": [], "bcc": []})
    }
    fn addresses(v: &Value) -> Vec<String> {
        v.as_array().unwrap_or(&vec![]).iter().map(|c| c["address"].as_str().unwrap().to_string()).collect()
    }

    #[tokio::test]
    async fn contacts_search_finds_a_sender_by_name_and_never_the_user() {
        let (_d, state) = state(true);
        save(&state, "a1", "INBOX", json!([
            mail(1, "2026-10-18T09:00:00Z", ("Anna Smith", "anna@x.io"), ("", "me@h.io")),
            mail(2, "2026-10-01T09:00:00Z", ("Joanna Doe", "jo@d.io"), ("", "me@h.io")),
        ]))
        .await;
        save(&state, "a2", "Sent", json!([mail(3, "2026-10-10T09:00:00Z", ("", "me@work.io"), ("Ann Lee", "ann.lee@y.io"))])).await;
        let params = |q: &str, boost: &str| json!({"accountIds": ["a1", "a2"], "ownAddresses": ["me@h.io", "me@work.io"], "query": q, "boostAccountId": boost});
        let v = call(&state, "people.contacts.search", params("ann", "")).await;
        assert_eq!(addresses(&v["result"]), ["anna@x.io", "ann.lee@y.io", "jo@d.io"], "{v}");
        let v = call(&state, "people.contacts.search", params("ann", "a2")).await;
        assert_eq!(addresses(&v["result"]), ["ann.lee@y.io", "anna@x.io", "jo@d.io"], "{v}");
        assert_eq!(v["result"][0]["accountIds"], json!(["a2"]));
        assert_eq!(v["result"][0]["name"], "Ann Lee");
        let v = call(&state, "people.contacts.search", params("me", "")).await;
        assert_eq!(addresses(&v["result"]), Vec::<String>::new(), "{v}");
    }

    #[tokio::test]
    async fn contacts_top_lists_one_account_latest_and_popular() {
        let (_d, state) = state(true);
        save(&state, "a1", "INBOX", json!([
            mail(1, "2026-10-18T09:00:00Z", ("Anna Smith", "anna@x.io"), ("", "me@h.io")),
            mail(2, "2026-10-01T09:00:00Z", ("Bo", "bo@b.io"), ("", "me@h.io")),
            mail(3, "2026-10-02T09:00:00Z", ("Bo", "bo@b.io"), ("", "me@h.io")),
        ]))
        .await;
        save(&state, "a2", "INBOX", json!([mail(4, "2026-10-19T09:00:00Z", ("Cy", "cy@c.io"), ("", "me@work.io"))])).await;
        let own = json!(["me@h.io", "me@work.io"]);
        let v = call(&state, "people.contacts.top", json!({"accountIds": ["a1", "a2"], "ownAddresses": own, "accountId": "a1"})).await;
        assert_eq!(addresses(&v["result"]["latest"]), ["anna@x.io", "bo@b.io"], "{v}");
        assert_eq!(addresses(&v["result"]["popular"]), ["bo@b.io", "anna@x.io"], "{v}");
        assert_eq!(v["result"]["popular"][0]["count"], 2);
        let v = call(&state, "people.contacts.top", json!({"accountIds": ["a1", "a2"], "ownAddresses": own})).await;
        assert_eq!(addresses(&v["result"]["latest"]), ["cy@c.io", "anna@x.io", "bo@b.io"], "{v}");
    }

    #[tokio::test]
    async fn contacts_names_hold_every_name_the_index_saw() {
        let (_d, state) = state(true);
        save(&state, "a1", "INBOX", json!([mail(1, "2026-10-18T09:00:00Z", ("Anna Smith", "anna@x.io"), ("Rokas Me", "me@h.io"))])).await;
        let v = call(&state, "people.contacts.names", json!({"accountIds": ["a1"]})).await;
        assert_eq!(v["result"], json!(["Anna Smith", "Rokas Me"]), "{v}");
    }

    /// The app's own header writes reach the index once each: the JS used to
    /// add the loaded rows itself because only the sync engine fed it.
    #[tokio::test]
    async fn mail_the_app_caches_reaches_the_index_once() {
        let (_d, state) = state(true);
        let first = json!([mail(1, "2026-10-18T09:00:00Z", ("Anna Smith", "anna@x.io"), ("", "me@h.io"))]);
        save(&state, "a1", "INBOX", first.clone()).await;
        let top = |state: Arc<DaemonState>| async move {
            call(&state, "people.contacts.top", json!({"accountIds": ["a1"], "ownAddresses": ["me@h.io"]})).await
        };
        assert_eq!(top(Arc::clone(&state)).await["result"]["popular"][0]["count"], 1);
        // the same folder saved again, and once more with a new message
        save(&state, "a1", "INBOX", first.clone()).await;
        let mut both = first.as_array().unwrap().clone();
        both.push(mail(2, "2026-10-19T09:00:00Z", ("Anna Smith", "anna@x.io"), ("", "me@h.io")));
        save(&state, "a1", "INBOX", Value::Array(both.clone())).await;
        save(&state, "a1", "INBOX", Value::Array(both)).await;
        save(&state, "a1", "Trash", json!([mail(9, "2026-10-19T10:00:00Z", ("Spam Ann", "spam@t.io"), ("", "me@h.io"))])).await;
        let v = top(Arc::clone(&state)).await;
        assert_eq!(addresses(&v["result"]["popular"]), ["anna@x.io"], "{v}");
        assert_eq!(v["result"]["popular"][0]["count"], 2, "{v}");
    }

    fn sender_names(v: &Value) -> Vec<String> {
        v["result"]["items"].as_array().unwrap().iter().map(|r| r["address"].as_str().unwrap().to_string()).collect()
    }
    const ME: &str = "me@h.io";

    #[tokio::test]
    async fn senders_lists_every_sender_with_saved_ones_linked() {
        let (_d, state) = state(true);
        save(&state, "a1", "INBOX", json!([
            mail(1, "2026-10-18T09:00:00Z", ("Anna Smith", "anna@x.io"), ("", ME)),
            mail(2, "2026-10-01T09:00:00Z", ("Bo", "bo@b.io"), ("", ME)),
        ]))
        .await;
        let saved = call(&state, "people.review.accept", json!({"items": [{"address": "anna@x.io", "name": "Anna Smith"}]})).await;
        assert!(saved.get("error").is_none(), "{saved}");
        let v = call(&state, "people.senders", json!({"ownAddresses": [ME], "sort": "name"})).await;
        assert_eq!(v["result"]["total"], 2, "{v}");
        assert_eq!(sender_names(&v), ["anna@x.io", "bo@b.io"]);
        assert!(v["result"]["items"][0]["personId"].is_string(), "{v}");
        assert!(v["result"]["items"][1]["personId"].is_null(), "{v}");
        assert!(v["result"]["indexReady"].is_boolean());
    }

    #[tokio::test]
    async fn a_senders_list_over_two_pages_does_not_wait_on_its_own_foreground_marker() {
        let (_d, state) = state(true);
        let n = 2100; // two scan pages of 2000
        crate::custody::with_conn(&state, |c| {
            let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
            for i in 0..n {
                let a = format!("s{i:05}@x.io");
                mailvault_core::people::message_addr::index_row(&tx, "acc", "INBOX", i as u32 + 1, 1000, &json!({"uid": i + 1, "from": {"address": a}}))?;
            }
            tx.commit().map_err(|e| e.to_string())
        })
        .unwrap();
        let t = std::time::Instant::now();
        let v = call(&state, "people.senders", json!({"limit": 5})).await;
        assert_eq!(v["result"]["total"], n);
        assert!(t.elapsed() < std::time::Duration::from_millis(350), "waited on itself: {:?}", t.elapsed());
    }

    #[tokio::test]
    async fn senders_search_and_sort_by_last() {
        let (_d, state) = state(true);
        save(&state, "a1", "INBOX", json!([
            mail(1, "2026-10-01T09:00:00Z", ("Anna", "anna@x.io"), ("", ME)),
            mail(2, "2026-10-18T09:00:00Z", ("Bo", "bo@b.io"), ("", ME)),
            mail(3, "2026-10-10T09:00:00Z", ("Annie", "annie@y.io"), ("", ME)),
        ]))
        .await;
        let v = call(&state, "people.senders", json!({"ownAddresses": [ME], "sort": "last"})).await;
        assert_eq!(sender_names(&v), ["bo@b.io", "annie@y.io", "anna@x.io"], "{v}");
        let v = call(&state, "people.senders", json!({"ownAddresses": [ME], "sort": "last", "query": "ANN"})).await;
        assert_eq!((sender_names(&v), v["result"]["total"].clone()), (vec!["annie@y.io".to_string(), "anna@x.io".to_string()], json!(2)), "{v}");
    }

    #[tokio::test]
    async fn messages_by_address_lists_an_unsaved_senders_mail() {
        let (_d, state) = state(true);
        save(&state, "a1", "INBOX", json!([
            mail(1, "2026-10-01T09:00:00Z", ("Bo", "bo@b.io"), ("", ME)),
            mail(2, "2026-10-02T09:00:00Z", ("Cy", "cy@c.io"), ("", ME)),
        ]))
        .await;
        let v = call(&state, "people.messages", json!({"address": " Bo@B.io ", "ownAddresses": [ME]})).await;
        let uids: Vec<_> = v["result"]["items"].as_array().unwrap().iter().map(|r| r["uid"].clone()).collect();
        assert_eq!(uids, [json!(1)], "{v}");
    }

    #[tokio::test]
    async fn messages_without_id_or_address_is_invalid() {
        let (_d, state) = state(true);
        let v = call(&state, "people.messages", json!({})).await;
        assert!(v.to_string().contains("missing id or address"), "{v}");
    }

    #[tokio::test]
    async fn stats_by_address_counts_an_unsaved_sender() {
        let (_d, state) = state(true);
        save(&state, "a1", "INBOX", json!([
            mail(1, "2026-10-01T09:00:00Z", ("Bo", "bo@b.io"), ("", ME)),
            mail(2, "2026-10-02T09:00:00Z", ("Bo", "bo@b.io"), ("", ME)),
        ]))
        .await;
        let v = call(&state, "people.stats", json!({"addresses": ["Bo@B.io"], "ownAddresses": [ME]})).await;
        assert_eq!(v["result"]["bo@b.io"]["received"], 2, "{v}");
    }

    #[tokio::test]
    async fn owners_maps_addresses_to_saved_contacts() {
        let (_d, state) = state(true);
        let saved = call(&state, "people.review.accept", json!({"items": [{"address": "anna@x.io", "name": "Anna"}]})).await;
        assert!(saved.get("error").is_none(), "{saved}");
        let v = call(&state, "people.owners", json!({"addresses": ["Anna@X.io", "bo@b.io"]})).await;
        assert_eq!(v["result"]["anna@x.io"]["favorite"], false, "{v}");
        assert!(v["result"]["anna@x.io"]["personId"].is_string(), "{v}");
        assert!(v["result"].get("bo@b.io").is_none(), "{v}");
    }
}
