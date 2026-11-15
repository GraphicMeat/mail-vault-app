//! Network Activity on the phone: `mobile.netActivity.list` and `mobile.netActivity.setRetention`,
//! the phone's half of desktop's Settings > Network Activity (daemon `handlers/net_activity.rs`).
//!
//! Core records every connection it opens for the engine (`net_activity`): IMAP and SMTP per
//! connection, DNS lookups, and every HTTPS request through a `Tracked` client (OAuth sign-in and
//! token refresh, Graph, JMAP, and the engine's own billing calls in `billing_client`). Here one
//! process-wide listener places each event (core's `geo_ip`, the bundled offline database: no
//! address leaves the phone to be placed) and queues it for core's `net_log` store, which keeps it
//! for the chosen period (`Retention`, a week by default) and prunes on its own. The store is a
//! core `app.db` under `<data_dir>/core/` (its `net_events` table and its retention key), apart
//! from `mobile.db`, so no `mobile.db` schema step is needed; the unsubscribe history
//! (`unsubscribe.rs`) lives in the same file.
//!
//! The engine can be open twice in one process (setup's and a background run's), and core has one
//! listener per process: every live engine of one data dir shares one store, so an event is kept
//! once, and the listener feeds every live store (tests open many engines at once, each its own
//! dir). The listener runs on the connection's own task under core's listener lock, so it only
//! queues (`NetLog::push` never waits on SQLite).
//!
//! `mobile.netActivity.list {sinceMs?, untilMs?, account?, country?}`: `{events, countries,
//! summary, retention}`: the newest `net_log::TABLE_ROWS` events (`country` narrows these only),
//! where the connections went, the totals and the accounts seen, and the period. Protocol and
//! purpose narrow the rows on the page, as on desktop. What was queued before the call is stored
//! first, so a connection that just closed is in the answer.
//! `mobile.netActivity.setRetention {retention: day|week|twoWeeks|month}`: sets it and prunes at once.

use crate::db::Engine;
use crate::rpc::RpcError;
use mailvault_core::geo_ip::Locator;
use mailvault_core::net_activity;
use mailvault_core::net_log::{self, NetLog, Query, Retention};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Once, Weak};

/// The live stores, by their directory.
static STORES: Mutex<Vec<(PathBuf, Weak<NetLog>)>> = Mutex::new(Vec::new());
static LISTENING: Once = Once::new();

/// The core `app.db` directory of the engine whose data dir is `data_dir`.
pub(crate) fn core_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("core")
}

fn stores() -> std::sync::MutexGuard<'static, Vec<(PathBuf, Weak<NetLog>)>> {
    STORES.lock().unwrap_or_else(|p| p.into_inner())
}

/// The store of `data_dir`: the one a live engine of that dir already holds, else a new one (its
/// writer thread opens the file; a file that will not open keeps nothing, the rest still works).
/// The first call in a process starts the listener.
pub(crate) fn open(data_dir: &Path) -> Arc<NetLog> {
    let dir = core_dir(data_dir);
    let log = {
        let mut stores = stores();
        stores.retain(|(_, w)| w.strong_count() > 0);
        match stores.iter().find(|(d, _)| *d == dir).and_then(|(_, w)| w.upgrade()) {
            Some(log) => log,
            None => {
                let log = Arc::new(NetLog::start(&dir));
                stores.push((dir, Arc::downgrade(&log)));
                log
            }
        }
    };
    // Never under `STORES`: the listener takes it under core's listener lock.
    LISTENING.call_once(|| {
        let locator = Locator::default();
        net_activity::subscribe(Box::new(move |ev| {
            let country = locator.locate(ev);
            let live: Vec<Arc<NetLog>> = stores().iter().filter_map(|(_, w)| w.upgrade()).collect();
            for log in live {
                log.push(ev, country.clone());
            }
        }));
    });
    log
}

fn internal(e: String) -> RpcError {
    RpcError::Internal(e)
}

fn to_json<T: serde::Serialize>(v: T) -> Result<Value, RpcError> {
    serde_json::to_value(v).map_err(|e| internal(e.to_string()))
}

pub(crate) fn list(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let q: Query = if params.is_null() { Query::default() } else { serde_json::from_value(params).map_err(|e| RpcError::Invalid(e.to_string()))? };
    let log = &engine.shared().net_log;
    log.flush();
    log.read(|c| {
        let events = net_log::recent(c, &q, net_log::TABLE_ROWS)?;
        let countries = net_log::geo(c, &q)?;
        let summary = net_log::summary(c, &q)?;
        Ok(json!({ "events": events, "countries": countries, "summary": summary, "retention": net_log::retention(c) }))
    })
    .map_err(internal)
}

pub(crate) fn set_retention(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let r: Retention = serde_json::from_value(params.get("retention").cloned().unwrap_or(Value::Null))
        .map_err(|_| RpcError::Invalid("retention must be day, week, twoWeeks or month".into()))?;
    engine.shared().net_log.set_retention(r).map_err(internal)?;
    Ok(json!({ "retention": to_json(r)? }))
}
