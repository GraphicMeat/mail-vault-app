//! Network Activity's reads and its one setting, over `net_log`'s store in
//! `app.db`. New events still arrive live as `net-activity` (main.rs).
//!
//! - `net.activity { sinceMs?, untilMs?, account?, country? }`: the newest
//!   `TABLE_ROWS` matching, newest arrival first.
//! - `net.geo { sinceMs?, untilMs?, account? }`: where the connections went.
//! - `net.summary { sinceMs?, untilMs?, account? }`: totals, and the accounts
//!   seen in the window.
//! - `net.retention` / `net.set_retention { retention }`: how long events are
//!   kept; setting it prunes at once.
use crate::handlers::common::{blocking, done};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::net_log::{self, Query, Retention};
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    let query = || serde_json::from_value::<Query>(params.clone()).unwrap_or_default();
    let log = Arc::clone(&state.net_log);
    Some(match method {
        "net.activity" => {
            let q = query();
            let read = blocking(move || log.read(|c| net_log::recent(c, &q, net_log::TABLE_ROWS))).await.and_then(|r| r);
            match read {
                Ok(rows) => RpcResponse::success(id, json!({ "events": rows })),
                // The store is unreadable: this run's events are still in
                // memory, so the page is not left empty.
                Err(e) => {
                    tracing::warn!("[net-activity] store unreadable, answering from memory: {e}");
                    RpcResponse::success(id, json!({ "events": from_memory(&query()) }))
                }
            }
        }
        "net.geo" => {
            let q = query();
            done(id, blocking(move || log.read(|c| to_json(net_log::geo(c, &q)?))).await.and_then(|r| r).map(|v| json!({ "countries": v })))
        }
        "net.summary" => {
            let q = query();
            done(id, blocking(move || log.read(|c| to_json(net_log::summary(c, &q)?))).await.and_then(|r| r))
        }
        "net.retention" => done(
            id,
            blocking(move || log.read(|c| Ok(net_log::retention(c)))).await.and_then(|r| r).map(|r| json!({ "retention": r })),
        ),
        "net.set_retention" => {
            let Ok(r) = serde_json::from_value::<Retention>(params["retention"].clone()) else {
                return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "retention must be day, week, twoWeeks or month"));
            };
            done(id, blocking(move || log.set_retention(r)).await.and_then(|r| r).map(|()| json!({ "retention": r })))
        }
        _ => return None,
    })
}

/// The daemon's one `net_activity` listener: each recorded event is placed
/// on the map (in memory, the bundled database), goes to the app as it
/// happens, and is queued for the store. It runs under the ring's lock on
/// the connection's own task, so it only sends: never `record`, `subscribe`,
/// nor SQLite.
pub(crate) fn listener(
    events: crate::events::EventBus,
    log: Arc<net_log::NetLog>,
) -> impl Fn(&mailvault_core::net_activity::NetEvent) + Send + Sync + 'static {
    let locator = mailvault_core::geo_ip::Locator::default();
    move |ev| {
        let country = locator.locate(ev);
        if let Ok(mut v) = serde_json::to_value(ev) {
            v["country"] = country.clone().into();
            events.emit("net-activity", v);
        }
        log.push(ev, country);
    }
}

fn to_json<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

/// The in-memory ring, narrowed like the store's query. It carries no
/// country, so a country filter matches none of it.
fn from_memory(q: &Query) -> Vec<mailvault_core::net_activity::NetEvent> {
    if q.country.as_deref().is_some_and(|c| !c.is_empty()) {
        return Vec::new();
    }
    let account = q.account.as_deref().filter(|a| !a.is_empty());
    mailvault_core::net_activity::snapshot()
        .into_iter()
        .filter(|e| q.since_ms.is_none_or(|s| e.at_ms >= s) && q.until_ms.is_none_or(|u| e.at_ms < u))
        .filter(|e| account.is_none_or(|a| e.account.as_deref() == Some(a)))
        .collect()
}

#[cfg(test)]
mod tests {
    use crate::server::DaemonState;
    use serde_json::json;

    async fn call(state: &std::sync::Arc<DaemonState>, method: &str, params: serde_json::Value) -> serde_json::Value {
        serde_json::to_value(crate::server::handle_request_for_test(state, method, params).await).unwrap()
    }

    #[tokio::test]
    async fn retention_defaults_to_a_week_and_a_bad_value_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(tmp.path().to_path_buf(), tmp.path().to_path_buf(), false);
        assert_eq!(call(&state, "net.retention", json!({})).await["result"]["retention"], "week");
        let set = call(&state, "net.set_retention", json!({"retention": "twoWeeks"})).await;
        assert_eq!(set["result"]["retention"], "twoWeeks");
        assert_eq!(call(&state, "net.retention", json!({})).await["result"]["retention"], "twoWeeks");
        let bad = call(&state, "net.set_retention", json!({"retention": "forever"})).await;
        assert!(bad.get("error").is_some(), "{bad}");
    }

    /// Called directly, never through `subscribe`: the listener is global and
    /// `the_listener_sees_every_record` owns it.
    #[tokio::test]
    async fn the_listener_sends_the_event_live_with_its_country_and_keeps_it() {
        let tmp = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(tmp.path().to_path_buf(), tmp.path().to_path_buf(), false);
        let mut live = state.events.subscribe();
        let listen = super::listener(state.events.clone(), std::sync::Arc::clone(&state.net_log));
        let mut e = mailvault_core::net_activity::NetEvent::out(mailvault_core::net_activity::Protocol::Https, "dns.google", 443, "listener-test");
        e.ip = Some("8.8.8.8".into());
        listen(&e);
        let line = live.try_recv().expect("sent live");
        assert!(line.contains("\"net-activity\""), "{line}");
        assert!(line.contains("\"country\":\"US\""), "{line}");
        state.net_log.flush();
        let table = call(&state, "net.activity", json!({})).await;
        assert_eq!(table["result"]["events"][0]["purpose"], "listener-test");
        assert_eq!(table["result"]["events"][0]["country"], "US");
    }

    #[tokio::test]
    async fn the_table_geo_and_summary_read_what_the_writer_stored() {
        let tmp = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(tmp.path().to_path_buf(), tmp.path().to_path_buf(), false);
        let now = mailvault_core::net_activity::now_ms();
        let mut e = mailvault_core::net_activity::NetEvent::out(mailvault_core::net_activity::Protocol::Imap, "imap.de.test", 993, "sync");
        e.at_ms = now;
        e.account = Some("one@x.test".into());
        e.bytes_up = 7;
        state.net_log.push(&e, Some("DE".into()));
        state.net_log.flush();
        let since = json!({"sinceMs": now - 1000});
        let table = call(&state, "net.activity", since.clone()).await;
        assert_eq!(table["result"]["events"][0]["host"], "imap.de.test");
        assert_eq!(table["result"]["events"][0]["country"], "DE");
        assert_eq!(table["result"]["events"][0]["account"], "one@x.test");
        let none = call(&state, "net.activity", json!({"country": "US"})).await;
        assert_eq!(none["result"]["events"], json!([]));
        let geo = call(&state, "net.geo", since.clone()).await;
        assert_eq!(geo["result"]["countries"][0]["country"], "DE");
        assert_eq!(geo["result"]["countries"][0]["connections"], 1);
        let summary = call(&state, "net.summary", since).await;
        assert_eq!(summary["result"]["sent"], 7);
        assert_eq!(summary["result"]["accounts"], json!(["one@x.test"]));
    }
}
