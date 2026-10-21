//! Phase 1 row 23: the Insights aggregation runs here, not in the app's web
//! worker. `insights.build` pages a whole Insights snapshot in-process (the
//! same `insights_begin_snapshot` / `insights_read_page` bodies the routes in
//! `handlers::insights` answer), normalizes each page into a
//! `mailvault_core::insights_model::Model` on a background thread, and
//! reports `insights-build-progress` frames as it goes. The app then asks
//! `insights.aggregate` (the charts) and `insights.messages` (a drill-down)
//! of that one model as often as its controls change, and `insights.release`
//! drops it when the workspace closes.
//!
//! Frames, all carrying the app's `buildId`: `{loaded, total, coverage}` per
//! page, then one last `{finished: true, ok: true, loaded, coverage}` or
//! `{finished: true, ok: false, error: {code, coverage?}}`. A snapshot that a
//! sync made stale mid-walk is walked again after 250, 500 and 1000 ms, as
//! the app's `insightsSession.js` did. `insights.status` answers the same
//! state for an app whose event stream lagged.
//!
//! Wire shape, like the snapshot routes: every reply is `Ok`, a failure is
//! `{"ok": false, "error": {code, ...}}` with a code, never English.

use crate::handlers::common::{blocking, str_arg, vec_arg};
use crate::handlers::insights::{begin_snapshot, read_page};
use crate::insights;
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::insights_model::{Builder, Model};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub(crate) const PROGRESS_EVENT: &str = "insights-build-progress";
/// A model nobody asked about for this long is dropped: the workspace closed
/// without a release (the webview went away).
const IDLE: Duration = Duration::from_secs(30 * 60);
/// Built models kept at once; the oldest idle one goes first.
const MAX_MODELS: usize = 3;
const STALE_BACKOFF_MS: [u64; 3] = [250, 500, 1000];

enum Slot {
    Building { cancel: Arc<AtomicBool>, loaded: usize, total: Option<usize>, coverage: Value },
    Ready { model: Arc<Model>, loaded: usize, coverage: Value },
    Failed { error: Value },
}

struct Entry {
    slot: Slot,
    touched: Instant,
}

/// The built models, by the app's `buildId`. Held in
/// `DaemonState::insights` beside the snapshots it is built from.
#[derive(Default, Clone)]
pub(crate) struct Models {
    inner: Arc<Mutex<HashMap<String, Entry>>>,
}

impl Models {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Drops idle models, and the oldest ready ones past `MAX_MODELS`. A
    /// build still running is never dropped here; its release cancels it.
    pub(crate) fn expire(&self, now: Instant) {
        let mut map = self.lock();
        map.retain(|_, e| matches!(e.slot, Slot::Building { .. }) || now.saturating_duration_since(e.touched) < IDLE);
        let mut ready: Vec<(String, Instant)> = map
            .iter()
            .filter(|(_, e)| matches!(e.slot, Slot::Ready { .. }))
            .map(|(id, e)| (id.clone(), e.touched))
            .collect();
        if ready.len() > MAX_MODELS {
            ready.sort_by_key(|(_, t)| *t);
            for (id, _) in ready.iter().take(ready.len() - MAX_MODELS) {
                map.remove(id);
            }
        }
    }

    fn release(&self, id: &str) {
        if let Some(Entry { slot: Slot::Building { cancel, .. }, .. }) = self.lock().remove(id) {
            cancel.store(true, Ordering::SeqCst);
        }
    }

    /// Updates a running build; `false` once it was released (cancelled).
    fn progress(&self, id: &str, loaded: usize, total: Option<usize>, coverage: &Value) -> bool {
        match self.lock().get_mut(id) {
            Some(Entry { slot: Slot::Building { loaded: l, total: t, coverage: c, .. }, .. }) => {
                (*l, *t, *c) = (loaded, total, coverage.clone());
                true
            }
            _ => false,
        }
    }

    /// Replaces a running build's slot with its outcome, unless it was
    /// released meanwhile.
    fn settle(&self, id: &str, slot: Slot) -> bool {
        let mut map = self.lock();
        match map.get_mut(id) {
            Some(entry @ Entry { slot: Slot::Building { .. }, .. }) => {
                *entry = Entry { slot, touched: Instant::now() };
                true
            }
            _ => false,
        }
    }

    fn model(&self, id: &str) -> Result<Arc<Model>, Value> {
        let mut map = self.lock();
        let entry = map.get_mut(id).ok_or_else(|| insights::error("modelExpired"))?;
        entry.touched = Instant::now();
        match &entry.slot {
            Slot::Ready { model, .. } => Ok(Arc::clone(model)),
            Slot::Building { .. } => Err(insights::error("modelBuilding")),
            Slot::Failed { error } => Err(error.clone()),
        }
    }

    fn status(&self, id: &str) -> Value {
        let mut map = self.lock();
        let Some(entry) = map.get_mut(id) else { return err(insights::error("modelExpired")) };
        entry.touched = Instant::now();
        match &entry.slot {
            Slot::Building { loaded, total, coverage, .. } => {
                json!({"ok": true, "state": "building", "loaded": loaded, "total": total, "coverage": coverage})
            }
            Slot::Ready { loaded, coverage, .. } => {
                json!({"ok": true, "state": "ready", "loaded": loaded, "coverage": coverage})
            }
            Slot::Failed { error } => err(error.clone()),
        }
    }
}

fn err(e: Value) -> Value {
    json!({"ok": false, "error": e})
}

fn code(e: &Value) -> &str {
    e["code"].as_str().unwrap_or("")
}

enum Attempt {
    Cancelled,
    Failed(Value),
}

/// One walk of a fresh snapshot into a model. The snapshot is released
/// whatever happens.
fn attempt(
    state: &Arc<DaemonState>,
    build_id: &str,
    account_ids: &[String],
    options: &Value,
    cancel: &AtomicBool,
) -> Result<(Model, usize, Value), Attempt> {
    let begin = begin_snapshot(state, account_ids);
    if begin["ok"] != true {
        return Err(Attempt::Failed(begin["error"].clone()));
    }
    let id = begin["snapshotId"].as_str().unwrap_or_default().to_string();
    let total = begin["inventoryCount"].as_u64().map(|n| n as usize);
    let walk = || -> Result<(Model, usize, Value), Attempt> {
        let mut coverage = begin["coverage"].clone();
        let models = &state.insights.models;
        let emit = |loaded: usize, coverage: &Value| {
            state.events.emit(PROGRESS_EVENT, json!({"buildId": build_id, "loaded": loaded, "total": total.unwrap_or(loaded), "coverage": coverage}));
        };
        if !models.progress(build_id, 0, total, &coverage) {
            return Err(Attempt::Cancelled);
        }
        emit(0, &coverage);
        let mut builder = Builder::new(options);
        let mut cursor: Option<String> = None;
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(Attempt::Cancelled);
            }
            let page = read_page(state, &id, cursor.as_deref());
            if page["ok"] != true {
                return Err(Attempt::Failed(page["error"].clone()));
            }
            if page["coverage"].is_object() {
                coverage = page["coverage"].clone();
            }
            if coverage["status"] == "stale" {
                return Err(Attempt::Failed(json!({"code": "stale", "coverage": coverage})));
            }
            let Some(rows) = page["rows"].as_array() else {
                return Err(Attempt::Failed(insights::error("invalidPage")));
            };
            for row in rows {
                builder.push(row);
            }
            if !models.progress(build_id, builder.len(), total.or(Some(builder.len())), &coverage) {
                return Err(Attempt::Cancelled);
            }
            emit(builder.len(), &coverage);
            cursor = page["nextCursor"].as_str().map(str::to_string);
            if cursor.is_none() {
                break;
            }
            // One page is one unit: let a foreground request in between.
            std::thread::yield_now();
        }
        let loaded = builder.len();
        Ok((builder.finish(), loaded, coverage))
    };
    let result = walk();
    state.insights.release(&id);
    result
}

/// Runs `attempt` until it succeeds, fails for good, or is cancelled
/// (`None`). A stale snapshot is walked again after each `STALE_BACKOFF_MS`
/// pause; the error that ends it keeps its code and the coverage to show.
fn retry_stale<T>(
    mut attempt: impl FnMut() -> Result<T, Attempt>,
    cancel: &AtomicBool,
    pause: impl Fn(Duration),
) -> Option<Result<T, Value>> {
    let mut tries = 0;
    loop {
        match attempt() {
            Ok(done) => return Some(Ok(done)),
            Err(Attempt::Cancelled) => return None,
            Err(Attempt::Failed(e)) if ["snapshotStale", "stale"].contains(&code(&e)) && tries < STALE_BACKOFF_MS.len() => {
                pause(Duration::from_millis(STALE_BACKOFF_MS[tries]));
                tries += 1;
                if cancel.load(Ordering::SeqCst) {
                    return None;
                }
            }
            Err(Attempt::Failed(e)) => {
                let mut error = json!({"code": code(&e), "message": "insights.failed"});
                if e["coverage"].is_object() {
                    error["coverage"] = e["coverage"].clone();
                }
                return Some(Err(error));
            }
        }
    }
}

/// The background half of `insights.build`.
fn run_build(state: Arc<DaemonState>, build_id: String, account_ids: Vec<String>, options: Value, cancel: Arc<AtomicBool>) {
    crate::mbox_upload_job::background_qos();
    let models = state.insights.models.clone();
    let outcome = match retry_stale(|| attempt(&state, &build_id, &account_ids, &options, &cancel), &cancel, std::thread::sleep) {
        Some(outcome) => outcome,
        None => return,
    };
    let frame = match outcome {
        Ok((model, loaded, coverage)) => {
            let frame = json!({"buildId": build_id, "finished": true, "ok": true, "loaded": loaded, "coverage": coverage});
            if !models.settle(&build_id, Slot::Ready { model: Arc::new(model), loaded, coverage }) {
                return;
            }
            frame
        }
        Err(error) => {
            if !models.settle(&build_id, Slot::Failed { error: error.clone() }) {
                return;
            }
            json!({"buildId": build_id, "finished": true, "ok": false, "error": error})
        }
    };
    models.expire(Instant::now());
    state.events.emit(PROGRESS_EVENT, frame);
}

macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "insights.build" => {
            let build_id = req!(str_arg(&id, params, "buildId"));
            if build_id.is_empty() || build_id.len() > 128 {
                return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "Invalid buildId"));
            }
            let account_ids: Vec<String> = req!(vec_arg(&id, params, "accountIds"));
            let options = json!({
                "accounts": params.get("accounts").cloned().unwrap_or(json!([])),
                "ownAddressesByAccount": params.get("ownAddressesByAccount").cloned().unwrap_or(json!({})),
            });
            let models = &state.insights.models;
            models.expire(Instant::now());
            let cancel = Arc::new(AtomicBool::new(false));
            {
                let mut map = models.lock();
                if map.contains_key(&build_id) {
                    return Some(RpcResponse::success(id, err(insights::error("buildExists"))));
                }
                let slot = Slot::Building { cancel: Arc::clone(&cancel), loaded: 0, total: None, coverage: Value::Null };
                map.insert(build_id.clone(), Entry { slot, touched: Instant::now() });
            }
            let state = Arc::clone(state);
            let reply_id = build_id.clone();
            std::thread::Builder::new()
                .name("insights-build".into())
                .spawn(move || run_build(state, build_id, account_ids, options, cancel))
                .map_or_else(
                    |_| RpcResponse::success(id.clone(), err(insights::error("snapshotUnavailable"))),
                    |_| RpcResponse::success(id.clone(), json!({"ok": true, "buildId": reply_id})),
                )
        }
        "insights.status" => {
            let build_id = req!(str_arg(&id, params, "buildId"));
            RpcResponse::success(id, state.insights.models.status(&build_id))
        }
        "insights.aggregate" | "insights.messages" => {
            let build_id = req!(str_arg(&id, params, "buildId"));
            let model = match state.insights.models.model(&build_id) {
                Ok(m) => m,
                Err(e) => return Some(RpcResponse::success(id, err(e))),
            };
            let query = params.get("query").cloned().unwrap_or(Value::Null);
            let selection = params.get("selection").cloned().unwrap_or_else(|| json!({}));
            let messages = method == "insights.messages";
            let result = blocking(move || {
                let answer = if messages { model.messages(&query, &selection) } else { model.query(&query) };
                match answer {
                    Ok(v) if messages => json!({"ok": true, "messages": v}),
                    Ok(v) => json!({"ok": true, "result": v}),
                    Err(_) => err(insights::error("invalidQuery")),
                }
            })
            .await
            .unwrap_or_else(|_| err(insights::error("modelUnavailable")));
            RpcResponse::success(id, result)
        }
        "insights.release" => {
            let build_id = req!(str_arg(&id, params, "buildId"));
            state.insights.models.release(&build_id);
            RpcResponse::success(id, json!({"ok": true}))
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custody;
    use crate::server::handle_request_for_test;
    use std::path::Path;

    fn st() -> (tempfile::TempDir, std::path::PathBuf, Arc<DaemonState>) {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap().keep();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir.clone(), true);
        (vault, app_dir, s)
    }

    fn set_accounts(app_dir: &Path, ids: &[&str]) {
        let list: Vec<Value> = ids.iter().map(|id| json!({"id": id})).collect();
        std::fs::write(app_dir.join("accounts.json"), json!(list).to_string()).unwrap();
    }

    /// Cached INBOX headers through the real write path `sync_engine` uses.
    fn seed(state: &Arc<DaemonState>, account: &str, emails: Value) {
        custody::with_conn(state, |c| {
            mailvault_core::custody::cache::save_mailboxes(c, account, &json!({"mailboxes":[{"path": "INBOX"}]}).to_string())?;
            mailvault_core::custody::cache::save_headers(c, account, "INBOX", &json!({"emails": emails}).to_string())
        })
        .expect("seed reaches the custody store");
    }

    fn inbox(n: u32) -> Value {
        Value::Array(
            (1..=n)
                .map(|uid| {
                    json!({"uid": uid, "subject": format!("Hello {uid}"), "messageId": format!("<m{uid}@test>"),
                        "from": {"address": if uid % 2 == 0 { "ana@example.test" } else { "ben@example.test" }, "name": "Someone"},
                        "to": [{"address": "me@example.test"}],
                        "date": "2026-09-08T10:00:00Z", "internalDate": "2026-09-08T10:00:05Z"})
                })
                .collect(),
        )
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> Value {
        handle_request_for_test(s, method, params).await.result.expect("an Ok reply")
    }

    fn options() -> Value {
        json!({"accounts": [{"id": "acc", "email": "me@example.test"}], "ownAddressesByAccount": {"acc": ["me@example.test"]}})
    }

    async fn build(s: &Arc<DaemonState>, build_id: &str) -> Vec<Value> {
        let mut rx = s.events.subscribe();
        let mut params = options();
        params["buildId"] = json!(build_id);
        params["accountIds"] = json!(["acc"]);
        let reply = call(s, "insights.build", params).await;
        assert_eq!(reply, json!({"ok": true, "buildId": build_id}));
        let mut frames = Vec::new();
        loop {
            let line = tokio::time::timeout(Duration::from_secs(20), rx.recv()).await.expect("a frame").expect("bus open");
            let v: Value = serde_json::from_str(&line).unwrap();
            if v["params"]["name"] != PROGRESS_EVENT || v["params"]["payload"]["buildId"] != build_id {
                continue;
            }
            let payload = v["params"]["payload"].clone();
            let done = payload["finished"] == true;
            frames.push(payload);
            if done {
                return frames;
            }
        }
    }

    fn query() -> Value {
        json!({"accountIds": ["acc"], "startDate": "2026-09-01", "endDate": "2026-09-09", "timeZone": "UTC",
            "direction": "received", "senderAddress": null, "hideAutomated": false, "timelineBucket": "week", "senderSort": "count"})
    }

    #[tokio::test]
    async fn a_build_reports_pages_then_answers_aggregate_and_messages() {
        let (_v, app_dir, s) = st();
        set_accounts(&app_dir, &["acc"]);
        seed(&s, "acc", inbox(2500));
        let frames = build(&s, "b1").await;
        let last = frames.last().unwrap();
        assert_eq!(last["ok"], true, "{last}");
        assert_eq!(last["loaded"], 2500);
        // begin, three pages of at most 1000, then the finished frame
        assert_eq!(frames.len(), 5, "{frames:?}");
        assert_eq!(frames[0]["loaded"], 0);
        assert_eq!(frames[0]["total"], 2500);
        assert_eq!(frames[1]["loaded"], 1000);

        let agg = call(&s, "insights.aggregate", json!({"buildId": "b1", "query": query()})).await;
        assert_eq!(agg["ok"], true, "{agg}");
        assert_eq!(agg["result"]["totals"]["received"], 2500);
        let senders: Vec<_> = agg["result"]["senders"].as_array().unwrap().iter().map(|s| (s["address"].clone(), s["count"].clone())).collect();
        assert_eq!(senders, vec![(json!("ana@example.test"), json!(1250)), (json!("ben@example.test"), json!(1250))]);

        let mut q = query();
        q["senderAddress"] = json!("ana@example.test");
        let msgs = call(&s, "insights.messages", json!({"buildId": "b1", "query": q, "selection": {}})).await;
        assert_eq!(msgs["messages"].as_array().unwrap().len(), 1250);
        let key = msgs["messages"][0]["key"].clone();
        let one = call(&s, "insights.messages", json!({"buildId": "b1", "query": q, "selection": {"messageKey": key}})).await;
        assert_eq!(one["messages"].as_array().unwrap().len(), 1);
        assert_eq!(one["messages"][0]["copies"][0]["accountId"], "acc");

        let status = call(&s, "insights.status", json!({"buildId": "b1"})).await;
        assert_eq!(status["state"], "ready");
        assert_eq!(call(&s, "insights.release", json!({"buildId": "b1"})).await, json!({"ok": true}));
        let gone = call(&s, "insights.aggregate", json!({"buildId": "b1", "query": query()})).await;
        assert_eq!(gone["error"]["code"], "modelExpired");
    }

    #[tokio::test]
    async fn a_bad_query_is_a_code_not_an_error() {
        let (_v, app_dir, s) = st();
        set_accounts(&app_dir, &["acc"]);
        seed(&s, "acc", inbox(3));
        build(&s, "b2").await;
        let mut q = query();
        q["timeZone"] = json!("Not/AZone");
        let v = call(&s, "insights.aggregate", json!({"buildId": "b2", "query": q})).await;
        assert_eq!(v, json!({"ok": false, "error": {"code": "invalidQuery", "message": "invalidQuery"}}));
    }

    #[tokio::test]
    async fn a_scope_the_daemon_does_not_know_fails_in_the_last_frame() {
        let (_v, app_dir, s) = st();
        set_accounts(&app_dir, &["other"]);
        let frames = build(&s, "b3").await;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["ok"], false);
        assert_eq!(frames[0]["error"]["code"], "invalidAccountScope");
        assert_eq!(frames[0]["error"]["message"], "insights.failed");
        let status = call(&s, "insights.status", json!({"buildId": "b3"})).await;
        assert_eq!(status["error"]["code"], "invalidAccountScope");
    }

    #[tokio::test]
    async fn an_unreachable_vault_fails_with_its_code() {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap().keep();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir.clone(), false);
        set_accounts(&app_dir, &["acc"]);
        let frames = build(&s, "b4").await;
        assert_eq!(frames.last().unwrap()["error"]["code"], "vaultUnavailable");
    }

    #[tokio::test]
    async fn a_released_build_stops_and_never_reports() {
        let (_v, app_dir, s) = st();
        set_accounts(&app_dir, &["acc"]);
        seed(&s, "acc", inbox(5));
        let mut params = options();
        params["buildId"] = json!("b5");
        params["accountIds"] = json!(["acc"]);
        assert_eq!(call(&s, "insights.build", params.clone()).await["ok"], true);
        assert_eq!(call(&s, "insights.build", params).await["error"]["code"], "buildExists");
        call(&s, "insights.release", json!({"buildId": "b5"})).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let v = call(&s, "insights.aggregate", json!({"buildId": "b5", "query": query()})).await;
        assert_eq!(v["error"]["code"], "modelExpired");
    }

    #[test]
    fn a_stale_snapshot_is_walked_again_three_times_then_fails_with_its_coverage() {
        let cancel = AtomicBool::new(false);
        let pauses = std::cell::RefCell::new(Vec::new());
        let mut calls = 0;
        let outcome = retry_stale(
            || -> Result<(), Attempt> {
                calls += 1;
                Err(Attempt::Failed(json!({"code": "snapshotStale", "coverage": {"status": "stale"}})))
            },
            &cancel,
            |d| pauses.borrow_mut().push(d.as_millis()),
        );
        assert_eq!(calls, 4);
        assert_eq!(*pauses.borrow(), vec![250, 500, 1000]);
        assert_eq!(
            outcome,
            Some(Err(json!({"code": "snapshotStale", "message": "insights.failed", "coverage": {"status": "stale"}})))
        );

        let mut calls = 0;
        let outcome = retry_stale(
            || {
                calls += 1;
                if calls == 1 { Err(Attempt::Failed(json!({"code": "stale"}))) } else { Ok(7) }
            },
            &cancel,
            |_| {},
        );
        assert_eq!(outcome, Some(Ok(7)));
    }

    #[test]
    fn a_failure_that_is_not_stale_is_not_retried_and_a_cancel_ends_the_backoff() {
        let cancel = AtomicBool::new(false);
        let mut calls = 0;
        let outcome = retry_stale(
            || -> Result<(), Attempt> {
                calls += 1;
                Err(Attempt::Failed(json!({"code": "vaultUnavailable"})))
            },
            &cancel,
            |_| {},
        );
        assert_eq!(calls, 1);
        assert_eq!(outcome, Some(Err(json!({"code": "vaultUnavailable", "message": "insights.failed"}))));

        let mut calls = 0;
        let outcome = retry_stale(
            || -> Result<(), Attempt> {
                calls += 1;
                Err(Attempt::Failed(json!({"code": "snapshotStale"})))
            },
            &cancel,
            |_| cancel.store(true, Ordering::SeqCst),
        );
        assert_eq!((calls, outcome), (1, None));
    }

    #[tokio::test]
    async fn the_oldest_ready_models_go_past_the_cap() {
        let (_v, app_dir, s) = st();
        set_accounts(&app_dir, &["acc"]);
        seed(&s, "acc", inbox(2));
        for i in 0..=MAX_MODELS {
            build(&s, &format!("cap{i}")).await;
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let first = call(&s, "insights.status", json!({"buildId": "cap0"})).await;
        assert_eq!(first["error"]["code"], "modelExpired");
        let last = call(&s, "insights.status", json!({"buildId": format!("cap{MAX_MODELS}")})).await;
        assert_eq!(last["state"], "ready");
    }
}
