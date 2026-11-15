//! Network Activity on the phone: every connection core records (IMAP, SMTP, HTTPS for sign-in,
//! Graph, JMAP, billing) is kept on the phone through core's `net_log`, and `mobile.netActivity.*`
//! reads it back with core's queries. The listener is process-wide and tests run in parallel, so
//! each test looks for an event with a host of its own, never for counts.

use mailvault_core::net_activity::{record, NetEvent, Protocol};
use mailvault_mobile_engine::{Engine, MemorySecrets};
use serde_json::{json, Value};
use std::sync::Arc;

fn engine(dir: &std::path::Path) -> Engine {
    Engine::open(dir, &dir.join("cache"), Arc::new(MemorySecrets::default())).unwrap()
}

fn event(host: &str, ip: Option<&str>, purpose: &str, account: Option<&str>) -> NetEvent {
    let mut ev = NetEvent::out(Protocol::Https, host, 443, purpose);
    ev.ip = ip.map(str::to_string);
    ev.account = account.map(str::to_string);
    ev.bytes_up = 100;
    ev.bytes_down = 2000;
    ev.result = "ok".into();
    ev
}

fn hosts(reply: &Value) -> Vec<String> {
    reply["events"].as_array().unwrap().iter().map(|e| e["host"].as_str().unwrap().to_string()).collect()
}

#[test]
fn a_recorded_connection_is_kept_and_listed_with_its_country() {
    let dir = tempfile::tempdir().unwrap();
    let e = engine(dir.path());
    record(event("list-one.net-activity.test", Some("8.8.8.8"), "sync", Some("me@a.test")));

    let reply = e.rpc("mobile.netActivity.list", json!({})).unwrap();
    let row = reply["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["host"] == "list-one.net-activity.test")
        .cloned()
        .expect("the event is listed");
    assert_eq!(row["protocol"], "https");
    assert_eq!(row["purpose"], "sync");
    assert_eq!(row["account"], "me@a.test");
    assert_eq!(row["country"], "US");
    assert_eq!(row["bytesDown"], 2000);
    let us = reply["countries"].as_array().unwrap().iter().find(|p| p["country"] == "US").expect("placed in the US");
    assert!(us["hosts"].as_array().unwrap().iter().any(|h| h == "list-one.net-activity.test"));
    assert!(reply["summary"]["hosts"].as_u64().unwrap() >= 1);
    assert!(reply["summary"]["accounts"].as_array().unwrap().iter().any(|a| a == "me@a.test"));
    assert_eq!(reply["retention"], "week");
}

#[test]
fn the_account_and_time_filters_narrow_the_list() {
    let dir = tempfile::tempdir().unwrap();
    let e = engine(dir.path());
    record(event("mine.net-activity.test", None, "sync", Some("filter-me@a.test")));
    record(event("theirs.net-activity.test", None, "sync", Some("filter-other@a.test")));

    let mine = hosts(&e.rpc("mobile.netActivity.list", json!({ "account": "filter-me@a.test" })).unwrap());
    assert!(mine.contains(&"mine.net-activity.test".to_string()));
    assert!(!mine.contains(&"theirs.net-activity.test".to_string()));

    let future = e.rpc("mobile.netActivity.list", json!({ "sinceMs": u64::MAX / 2 })).unwrap();
    assert!(!hosts(&future).contains(&"mine.net-activity.test".to_string()));
}

#[test]
fn retention_is_kept_and_a_bad_value_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let e = engine(dir.path());
    let set = e.rpc("mobile.netActivity.setRetention", json!({ "retention": "month" })).unwrap();
    assert_eq!(set["retention"], "month");
    assert_eq!(e.rpc("mobile.netActivity.list", json!({})).unwrap()["retention"], "month");
    drop(e);
    // Kept across a restart.
    let e = engine(dir.path());
    assert_eq!(e.rpc("mobile.netActivity.list", json!({})).unwrap()["retention"], "month");
    assert!(e.rpc("mobile.netActivity.setRetention", json!({ "retention": "forever" })).is_err());
}

#[test]
fn two_engines_on_one_phone_share_one_store() {
    let dir = tempfile::tempdir().unwrap();
    let a = engine(dir.path());
    let b = engine(dir.path());
    record(event("shared.net-activity.test", None, "sync", None));
    let listed = |e: &Engine| hosts(&e.rpc("mobile.netActivity.list", json!({})).unwrap()).iter().filter(|h| *h == "shared.net-activity.test").count();
    // One row, not one per engine: both write through the same store.
    assert_eq!(listed(&a), 1);
    assert_eq!(listed(&b), 1);
}
