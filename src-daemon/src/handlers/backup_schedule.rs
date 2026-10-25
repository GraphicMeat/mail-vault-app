//! Configuration only. JavaScript remains the scheduling/run owner in slice 1.
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::{
    backup_schedule as policy,
    settings_doc::{SettingsDoc, SettingsError, Snapshot},
};
use serde_json::{json, Map, Value};
use std::{path::Path, sync::Arc};

const STORE: &str = "mailvault-settings";

pub(crate) async fn route(
    state: &Arc<DaemonState>,
    method: &str,
    params: &Value,
    id: Value,
) -> Option<RpcResponse> {
    let mut response = route_with_view(state, method, params, id, view).await?;
    if let Some(Value::Object(result)) = response.result.as_mut() {
        if let Value::Object(live) = state.backup_worker.status() {
            result.extend(live);
        }
    }
    Some(response)
}

// Narrow preparation seam: settings writes and the event bus remain real.
async fn route_with_view(
    state: &Arc<DaemonState>,
    method: &str,
    params: &Value,
    id: Value,
    prepare: impl Fn(&Snapshot, &[String], i64) -> Result<Value, &'static str> + Send + 'static,
) -> Option<RpcResponse> {
    if !matches!(method, "backup.schedule.get" | "backup.schedule.set") {
        return None;
    }
    let set = method == "backup.schedule.set";
    let valid = params.as_object().is_some_and(|p| {
        p.keys()
            .all(|k| set && matches!(k.as_str(), "baseVersion" | "patch"))
    }) && (!set
        || (params.get("patch").is_some()
            && params
                .get("baseVersion")
                .is_none_or(|v| v.as_u64().is_some())));
    if !valid {
        return Some(RpcResponse::error(
            id,
            ipc::INVALID_PARAMS,
            "errors.settingsInvalid",
        ));
    }
    let rearm = params["patch"]["backupGlobalEnabled"] == true
        || params["patch"]["backupSchedules"].is_object();
    let params = params.clone();
    let app_dir = state.app_dir.clone();
    let now = state.clock.now_ms();
    let joined =
        tokio::task::spawn_blocking(move || run(&app_dir, set, &params, now, prepare)).await;
    Some(match joined.unwrap_or(Err("errors.settingsWriteFailed")) {
        Ok((snapshot, change)) => {
            if set {
                crate::backup_worker::configuration_changed(state, rearm);
            }
            if let Some(change) = change.filter(|c| !c.changed.is_empty()) {
                state.events.emit(
                    super::settings::CHANGED_EVENT,
                    json!({"keys":change.changed,"version":change.version}),
                );
            }
            RpcResponse::success(id, snapshot)
        }
        Err(key) => RpcResponse::error(
            id,
            if key == "errors.settingsInvalid" {
                ipc::INVALID_PARAMS
            } else {
                ipc::INTERNAL_ERROR
            },
            key,
        ),
    })
}
fn loaded(doc: &SettingsDoc) -> Result<mailvault_core::settings_doc::Snapshot, &'static str> {
    let snapshot = doc.get(None).map_err(|e| e.catalog_key())?;
    if snapshot.recovered.is_some() {
        return Err("errors.settingsNotLoaded");
    }
    if !snapshot
        .values
        .get(STORE)
        .and_then(|s| s.get("state"))
        .is_some_and(Value::is_object)
    {
        return Err("errors.settingsNotLoaded");
    }
    Ok(snapshot)
}
fn view(snapshot: &Snapshot, ids: &[String], now: i64) -> Result<Value, &'static str> {
    let settings = &snapshot.values[STORE]["state"];
    // Fresh system lookup per call. Never persist an offset or assume UTC.
    let zone = policy::local_zone()?;
    let mut next = Map::new();
    let mut invalid = Vec::new();
    for id in ids {
        let config = policy::schedule_for(settings, id);
        if config["enabled"] != true {
            continue;
        }
        match policy::next_in_zone(&settings["backupState"][id], &config, now, &zone) {
            Ok(epoch) => {
                next.insert(id.clone(), json!(epoch));
            }
            Err(_) => {
                next.insert(id.clone(), Value::Null);
                invalid.push(id.clone());
            }
        }
    }
    Ok(
        json!({"version":snapshot.version,"config":policy::config_view(settings),
        "state":{"backupState":settings["backupState"],"backupHistory":settings["backupHistory"],"snapshotLastTimes":settings["snapshotLastTimes"]},
        "nextEligibleTimes":next,"invalidSchedules":invalid,
        "owner":"daemon","queue":[],"active":null,"pendingAccess":[],"lastOutcomes":[]}),
    )
}
fn run(
    path: &Path,
    set: bool,
    params: &Value,
    now: i64,
    prepare: impl Fn(&Snapshot, &[String], i64) -> Result<Value, &'static str>,
) -> Result<(Value, Option<mailvault_core::settings_doc::Change>), &'static str> {
    let ids =
        super::insights::configured_account_ids(path).map_err(|_| "errors.settingsNotLoaded")?;
    let doc = SettingsDoc::shared(path);
    if !set {
        return Ok((prepare(&loaded(&doc)?, &ids, now)?, None));
    }
    let patch = &params["patch"];
    policy::validate_patch(patch)?;
    let document_patch = json!({STORE:{"state":patch}});
    // Prepare the exact applied view before mutation, including its immutable
    // timezone. The version fence proves the same document is patched. Once
    // patch succeeds there is no fallible read/view work that can hide Change.
    for attempt in 0..3 {
        let snapshot = loaded(&doc)?;
        let base = snapshot.version;
        if params
            .get("baseVersion")
            .and_then(Value::as_u64)
            .is_some_and(|v| v != base)
        {
            return Err("errors.settingsConflict");
        }
        let mut applied = Value::Object(snapshot.values);
        mailvault_core::settings_doc::merge_patch(&mut applied, &document_patch);
        let Value::Object(values) = applied else {
            unreachable!("object document patch")
        };
        let applied = Snapshot {
            values,
            version: base,
            recovered: None,
        };
        let Value::Object(mut response) = prepare(&applied, &ids, now)? else {
            return Err("errors.settingsInvalid");
        };
        match doc.patch(&document_patch, Some(base)) {
            Ok(change) => {
                // This is the known applied snapshot, even if a later writer
                // has already advanced the file. No postcommit IO is needed.
                response.insert("version".into(), json!(change.version));
                return Ok((Value::Object(response), Some(change)));
            }
            Err(SettingsError::Conflict { .. })
                if params.get("baseVersion").is_none() && attempt < 2 =>
            {
                continue
            }
            Err(e) => return Err(e.catalog_key()),
        }
    }
    unreachable!("bounded patch attempts return a result")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::{handle_request_for_test, DaemonState};
    async fn call(state: &Arc<DaemonState>, method: &str, params: Value) -> Result<Value, String> {
        let response = handle_request_for_test(state, method, params).await;
        if let Some(error) = response.error {
            Err(error.message)
        } else {
            Ok(response.result.unwrap())
        }
    }
    fn rig() -> (tempfile::TempDir, Arc<DaemonState>) {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().join("mail"), dir.path().into(), true);
        SettingsDoc::shared(dir.path()).replace(&json!({STORE:{"version":3,"state":{"language":"en","backupState":{"one":{"lastBackupTime":42}},"backupHistory":{"one":[{"success":true}]},"snapshotLastTimes":{"one":42}}}}),None).unwrap();
        std::fs::write(dir.path().join("accounts.json"), r#"[{"id":"one"}]"#).unwrap();
        (dir, state)
    }
    #[tokio::test]
    async fn configuration_route_is_callable_targeted_versioned_and_never_starts_work() {
        let (_dir, state) = rig();
        let got = call(&state, "backup.schedule.get", json!({}))
            .await
            .unwrap();
        let set = call(&state,"backup.schedule.set",json!({"baseVersion":got["version"],"patch":{"backupGlobalEnabled":true,"backupGlobalConfig":{"interval":"hours","hours":[1,2]}}})).await.unwrap();
        assert!(set["version"].as_u64().unwrap() > got["version"].as_u64().unwrap());
        assert_eq!(set["config"]["backupGlobalEnabled"], true);
        assert_eq!(
            set["state"]["backupHistory"]["one"],
            json!([{"success":true}])
        );
        assert_eq!(set["owner"], "daemon");
        assert_eq!(set["active"], Value::Null);
        assert!(state.backup_runs.lock().unwrap().is_empty());
        assert_eq!(
            SettingsDoc::shared(&state.app_dir)
                .get(None)
                .unwrap()
                .values[STORE]["version"],
            3
        );
        assert_eq!(
            call(
                &state,
                "backup.schedule.set",
                json!({"baseVersion":got["version"],"patch":{"backupGlobalEnabled":false}})
            )
            .await
            .unwrap_err(),
            "errors.settingsConflict"
        );
        assert_eq!(
            call(&state, "backup.schedule.get", json!({}))
                .await
                .unwrap()["config"]["backupGlobalEnabled"],
            true
        );
    }
    #[tokio::test]
    async fn configuration_refuses_foreign_fields_invalid_dates_and_unavailable_accounts() {
        let (dir, state) = rig();
        for params in [
            json!({"patch":{"backupHistory":{}}}),
            json!({"patch":{"backupGlobalConfig":{"interval":"weekly","dayOfWeek":7}}}),
            json!({"patch":{},"baseVersion":"1"}),
            json!({"patch":{},"accountId":"credential-trap"}),
        ] {
            assert_eq!(
                call(&state, "backup.schedule.set", params)
                    .await
                    .unwrap_err(),
                "errors.settingsInvalid"
            );
        }
        std::fs::write(dir.path().join("accounts.json"), "broken").unwrap();
        assert_eq!(
            call(&state, "backup.schedule.get", json!({}))
                .await
                .unwrap_err(),
            "errors.settingsNotLoaded"
        );
    }
    #[tokio::test]
    async fn unavailable_view_refuses_set_without_mutation_or_event() {
        let (dir, state) = rig();
        let doc = SettingsDoc::shared(dir.path());
        doc.patch(&json!({STORE:{"state":{"backupGlobalEnabled":true}}}), None)
            .unwrap();
        let before = doc.get(None).unwrap();
        let bytes = std::fs::read(dir.path().join("frontend-settings.json")).unwrap();
        let mut events = state.events.subscribe();
        let response = route_with_view(
            &state,
            "backup.schedule.set",
            &json!({"baseVersion":before.version,"patch":{"backupGlobalEnabled":false}}),
            json!(1),
            |_, _, _| Err("errors.settingsInvalid"),
        )
        .await
        .unwrap();
        assert_eq!(response.error.unwrap().message, "errors.settingsInvalid");
        let after = doc.get(None).unwrap();
        assert_eq!(
            after.version, before.version,
            "failed timezone/view preparation must not commit"
        );
        assert_eq!(after.values, before.values);
        assert_eq!(
            std::fs::read(dir.path().join("frontend-settings.json")).unwrap(),
            bytes
        );
        assert!(
            events.try_recv().is_err(),
            "a refusal emits no settings change"
        );
        // The same captured version remains valid after the refusal.
        let accepted = call(
            &state,
            "backup.schedule.set",
            json!({"baseVersion":before.version,"patch":{"backupGlobalEnabled":false}}),
        )
        .await
        .unwrap();
        let (name, payload) =
            mailvault_core::daemon_ipc::parse_event(&events.try_recv().unwrap()).unwrap();
        assert_eq!(name, super::super::settings::CHANGED_EVENT);
        assert_eq!(
            payload,
            json!({"keys":[STORE],"version":accepted["version"]})
        );
        assert!(events.try_recv().is_err());
    }
    #[tokio::test]
    async fn set_prepares_applied_view_before_write_and_notifies_once() {
        let (dir, state) = rig();
        let doc = SettingsDoc::shared(dir.path());
        doc.patch(&json!({STORE:{"state":{"backupGlobalEnabled":true}}}), None)
            .unwrap();
        let before = doc.get(None).unwrap();
        let path = dir.path().to_path_buf();
        let mut events = state.events.subscribe();
        let response = route_with_view(
            &state,
            "backup.schedule.set",
            &json!({"baseVersion":before.version,"patch":{"backupGlobalEnabled":false}}),
            json!(2),
            move |snapshot, ids, now| {
                let observed = SettingsDoc::shared(&path)
                    .get(None)
                    .map_err(|_| "errors.settingsWriteFailed")?;
                if observed.version != before.version
                    || observed.values[STORE]["state"]["backupGlobalEnabled"] != true
                {
                    return Err("errors.settingsWriteFailed");
                }
                if snapshot.values[STORE]["state"]["backupGlobalEnabled"] != false {
                    return Err("errors.settingsInvalid");
                }
                view(snapshot, ids, now)
            },
        )
        .await
        .unwrap();
        assert!(response.error.is_none(), "{:?}", response.error);
        let accepted = response.result.unwrap();
        let after = doc.get(None).unwrap();
        assert_eq!(accepted["version"], after.version);
        assert!(after.version > before.version);
        assert_eq!(accepted["config"]["backupGlobalEnabled"], false);
        assert_eq!(
            accepted["state"]["backupHistory"],
            after.values[STORE]["state"]["backupHistory"]
        );
        let (name, payload) =
            mailvault_core::daemon_ipc::parse_event(&events.try_recv().unwrap()).unwrap();
        assert_eq!(name, super::super::settings::CHANGED_EVENT);
        assert_eq!(payload, json!({"keys":[STORE],"version":after.version}));
        assert!(
            events.try_recv().is_err(),
            "committed write emits exactly once"
        );
    }

    #[tokio::test]
    async fn implicit_retry_rebuilds_a_coherent_applied_view_after_concurrent_write() {
        let (dir, state) = rig();
        let doc = SettingsDoc::shared(dir.path());
        doc.patch(&json!({STORE:{"state":{"backupGlobalEnabled":true}}}), None)
            .unwrap();
        let before = doc.get(None).unwrap();
        let path = dir.path().to_path_buf();
        let once = std::sync::atomic::AtomicBool::new(false);
        let mut events = state.events.subscribe();
        let response=route_with_view(&state,"backup.schedule.set",&json!({"patch":{"backupGlobalEnabled":false}}),json!(3),move |snapshot,ids,now| {
            if !once.swap(true,std::sync::atomic::Ordering::SeqCst) {
                SettingsDoc::shared(&path).patch(&json!({STORE:{"state":{"backupState":{"one":{"lastBackupTime":84}},"backupHistory":{"one":[{"success":true,"timestamp":84}]}}}}),None).map_err(|e|e.catalog_key())?;
            }
            view(snapshot,ids,now)
        }).await.unwrap();
        assert!(response.error.is_none(), "{:?}", response.error);
        let accepted = response.result.unwrap();
        let after = doc.get(None).unwrap();
        assert_eq!(after.version, before.version + 2);
        assert_eq!(accepted["version"], after.version);
        assert_eq!(accepted["config"]["backupGlobalEnabled"], false);
        assert_eq!(
            accepted["state"]["backupState"]["one"]["lastBackupTime"],
            84
        );
        assert_eq!(
            accepted["state"]["backupHistory"],
            after.values[STORE]["state"]["backupHistory"]
        );
        let (name, payload) =
            mailvault_core::daemon_ipc::parse_event(&events.try_recv().unwrap()).unwrap();
        assert_eq!(name, super::super::settings::CHANGED_EVENT);
        assert_eq!(payload, json!({"keys":[STORE],"version":after.version}));
        assert!(events.try_recv().is_err());
    }
}
