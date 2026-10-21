//! `cleanup.*`: the auto-cleanup rules, run by the daemon (`cleanup_worker`).
//!
//! - `cleanup.rules.get`: the stored rules as the daemon reads them, each
//!   with `refused` (a catalog key, or null) and `runs` (enabled and readable).
//! - `cleanup.preview`: the dry run, from the caches only: `{ran, archived: 0,
//!   deleted, skipped: 0, rules: [{id, matched}]}`, `deleted` being what a run
//!   would try (the JS dry run's count), protected copies left out.
//! - `cleanup.run_now {mirrorRoot?}`: start a run on the worker. `{started}`;
//!   `started: false, running: true` while one is already going. The end is
//!   the `cleanup-run {state: "done", ran, lastRun}` event.
//! - `cleanup.status`: `{running, lastRun, nextDueAt}`.
//!
//! The rules stay written by the app (the Storage settings form, through the
//! settings document); nothing here writes `mailvault-settings`.

use crate::cleanup_worker::{self, Cmd, RUN_EVENT};
use crate::handlers::common;
use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use mailvault_core::cleanup_rules::{self, NoRun, RUN_INTERVAL_MS};
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    let result = match method {
        "cleanup.rules.get" => rules_get(state).await,
        "cleanup.preview" => preview(state).await,
        "cleanup.run_now" => run_now(state, params),
        "cleanup.status" => status(state).await,
        _ => return None,
    };
    Some(common::done(id, result))
}

async fn rules_get(state: &Arc<DaemonState>) -> Result<Value, String> {
    let st = Arc::clone(state);
    common::blocking(move || {
        let settings = cleanup_worker::settings_state(&st);
        let rules: Vec<Value> = cleanup_rules::stored_rules(&settings)
            .into_iter()
            .map(|mut r| {
                let (refused, runs) = match cleanup_rules::parse_rule(&r) {
                    Ok(Some(_)) => (Value::Null, true),
                    Ok(None) => (Value::Null, false),
                    Err(why) => (Value::String(why.catalog_key().to_string()), false),
                };
                if let Some(o) = r.as_object_mut() {
                    o.insert("refused".to_string(), refused);
                    o.insert("runs".to_string(), Value::Bool(runs));
                }
                r
            })
            .collect();
        json!({ "rules": rules })
    })
    .await
}

async fn preview(state: &Arc<DaemonState>) -> Result<Value, String> {
    let st = Arc::clone(state);
    common::blocking(move || {
        let settings = cleanup_worker::settings_state(&st);
        let now = st.clock.now_ms();
        match cleanup_worker::pick(&st, &settings, now) {
            Err(NoRun::NotPremium | NoRun::NoEnabledRules) => json!({ "ran": false, "archived": 0, "deleted": 0 }),
            Ok(p) => {
                let ids: Vec<Value> = cleanup_rules::stored_rules(&settings).iter().map(|r| r.get("id").cloned().unwrap_or(Value::Null)).collect();
                let work = cleanup_worker::group(&st, p.selection.candidates);
                let mut matched = vec![0u64; ids.len()];
                let mut total = 0u64;
                for w in &work {
                    for r in &w.rules {
                        let n: u64 = r.folders.values().map(|(_, c)| c.len() as u64).sum();
                        if let Some(m) = matched.get_mut(r.rule) {
                            *m += n;
                        }
                        total += n;
                    }
                }
                let rules: Vec<Value> = ids.into_iter().zip(matched).map(|(id, n)| json!({ "id": id, "matched": n })).collect();
                json!({ "ran": true, "archived": 0, "deleted": total, "skipped": 0, "rules": rules })
            }
        }
    })
    .await
}

fn run_now(state: &Arc<DaemonState>, params: &Value) -> Result<Value, String> {
    if !state.cleanup.claim() {
        return Ok(json!({ "started": false, "running": true }));
    }
    let mirror_root = params.get("mirrorRoot").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    if let Err(e) = state.cleanup.send(Cmd::Run { mirror_root }) {
        state.cleanup.release();
        return Err(e);
    }
    state.events.emit(RUN_EVENT, json!({ "state": "running", "manual": true }));
    Ok(json!({ "started": true }))
}

async fn status(state: &Arc<DaemonState>) -> Result<Value, String> {
    let st = Arc::clone(state);
    let last = common::blocking(move || cleanup_worker::last_run(&st)).await?;
    Ok(json!({
        "running": state.cleanup.running.load(std::sync::atomic::Ordering::SeqCst),
        "lastRun": last,
        "nextDueAt": last.as_ref().map(|r| r.at + RUN_INTERVAL_MS),
    }))
}
