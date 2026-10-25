//! `settings.*`: the daemon owns `frontend-settings.json`
//! (`mailvault_core::settings_doc`); every UI shell reads and changes it here.
//!
//! - `settings.get {keys?}`: `{values, version}`, the whole document or only
//!   the listed top-level keys that exist; `recovered` names where the values
//!   came from when the file on disk does not parse.
//! - `settings.patch {patch, baseVersion?}`: a JSON merge patch (null deletes,
//!   objects merge, arrays replace). `{version, changed}`.
//! - `settings.replace {values, baseVersion?}`: each listed top-level key is
//!   replaced whole, null deletes it. The app's persisted stores write this
//!   way (one key is one serialized store). `{version, changed}`.
//!
//! A `baseVersion` that is no longer current is refused
//! (`errors.settingsConflict`); without one, the last writer wins. Every
//! write that changed something emits `settings-changed {keys, version}`:
//! key names only, never a value (settings hold account and folder names).

use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::settings_doc::{Change, SettingsDoc, SettingsError};
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) const CHANGED_EVENT: &str = "settings-changed";

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    if !matches!(method, "settings.get" | "settings.patch" | "settings.replace") {
        return None;
    }
    let doc = SettingsDoc::shared(&state.app_dir);
    let method = method.to_string();
    let params = params.clone();
    // File IO and an fsync: off the async workers.
    let joined = tokio::task::spawn_blocking(move || run(&doc, &method, &params)).await;
    let outcome = joined.unwrap_or_else(|e| Err(SettingsError::Io(format!("settings task failed: {e}"))));
    Some(match outcome {
        Ok(Outcome::Read(v)) => RpcResponse::success(id, v),
        Ok(Outcome::Wrote(change)) => {
            if !change.changed.is_empty() {
                state.events.emit(CHANGED_EVENT, json!({"keys": change.changed, "version": change.version}));
            }
            RpcResponse::success(id, json!({"version": change.version, "changed": change.changed}))
        }
        Ok(Outcome::Rebased(change, snapshot)) => {
            if !change.changed.is_empty() {
                state.events.emit(CHANGED_EVENT, json!({"keys": change.changed, "version": change.version}));
            }
            RpcResponse::success(id, snapshot)
        }
        Err(e) => {
            let code = if matches!(e, SettingsError::NotAnObject) { ipc::INVALID_PARAMS } else { ipc::INTERNAL_ERROR };
            RpcResponse::error(id, code, e.catalog_key())
        }
    })
}

enum Outcome {
    Read(Value),
    Wrote(Change),
    Rebased(Change, Value),
}

fn base_version(params: &Value) -> Option<u64> {
    params.get("baseVersion").and_then(Value::as_u64)
}

fn run(doc: &SettingsDoc, method: &str, params: &Value) -> Result<Outcome, SettingsError> {
    match method {
        "settings.get" => {
            let keys: Option<Vec<String>> = params
                .get("keys")
                .and_then(Value::as_array)
                .map(|keys| keys.iter().filter_map(|k| k.as_str().map(str::to_owned)).collect());
            let snap = doc.get(keys.as_deref())?;
            let mut out = json!({"values": Value::Object(snap.values), "version": snap.version});
            if let Some(from) = snap.recovered {
                out["recovered"] = Value::String(from);
            }
            Ok(Outcome::Read(out))
        }
        "settings.patch" => {
            let patch = params.get("patch").ok_or(SettingsError::NotAnObject)?;
            doc.patch(patch, base_version(params)).map(Outcome::Wrote)
        }
        _ => {
            let values = params.get("values").ok_or(SettingsError::NotAnObject)?;
            if let Some(bases) = params.get("bases") {
                let change = doc.replace_rebased(values, bases, base_version(params))?;
                let snapshot = doc.get(None)?;
                Ok(Outcome::Rebased(change, json!({"values":snapshot.values,"version":snapshot.version})))
            } else {
                doc.replace(values, base_version(params)).map(Outcome::Wrote)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::{handle_request_for_test, DaemonState};

    fn rig() -> (tempfile::TempDir, Arc<DaemonState>) {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().join("mail"), dir.path().to_path_buf(), true);
        (dir, state)
    }

    fn on_disk(dir: &tempfile::TempDir) -> Value {
        serde_json::from_slice(&std::fs::read(dir.path().join("frontend-settings.json")).unwrap()).unwrap()
    }

    async fn call(state: &Arc<DaemonState>, method: &str, params: Value) -> Result<Value, String> {
        let resp = handle_request_for_test(state, method, params).await;
        match resp.error {
            Some(e) => Err(e.message),
            None => Ok(resp.result.unwrap_or(Value::Null)),
        }
    }

    #[tokio::test]
    async fn get_patch_and_replace_round_trip_through_the_route_chain() {
        let (dir, state) = rig();
        std::fs::write(dir.path().join("frontend-settings.json"), json!({"mailvault-theme": {"state": {"theme": "dark"}}}).to_string()).unwrap();

        let got = call(&state, "settings.get", json!({})).await.unwrap();
        assert_eq!(got["values"], json!({"mailvault-theme": {"state": {"theme": "dark"}}}));
        let v0 = got["version"].as_u64().unwrap();

        let patched = call(&state, "settings.patch", json!({"patch": {"mailvault-theme": {"state": {"palette": "teal"}}}})).await.unwrap();
        assert_eq!(patched["changed"], json!(["mailvault-theme"]));
        assert!(patched["version"].as_u64().unwrap() > v0);
        assert_eq!(on_disk(&dir), json!({"mailvault-theme": {"state": {"theme": "dark", "palette": "teal"}}}));

        let replaced = call(&state, "settings.replace", json!({"values": {"mailvault-theme": {"state": {"theme": "light"}}, "mailvault-focus": {"state": {}}}})).await.unwrap();
        assert_eq!(replaced["changed"], json!(["mailvault-focus", "mailvault-theme"]));
        assert_eq!(on_disk(&dir), json!({"mailvault-theme": {"state": {"theme": "light"}}, "mailvault-focus": {"state": {}}}));

        let some = call(&state, "settings.get", json!({"keys": ["mailvault-focus", "nope"]})).await.unwrap();
        assert_eq!(some["values"], json!({"mailvault-focus": {"state": {}}}));
        assert_eq!(some["version"], replaced["version"]);
    }

    #[tokio::test]
    async fn a_stale_base_version_and_a_non_object_are_refused_with_catalog_keys() {
        let (dir, state) = rig();
        let first = call(&state, "settings.patch", json!({"patch": {"a": 1}})).await.unwrap();
        call(&state, "settings.patch", json!({"patch": {"a": 2}})).await.unwrap();
        let stale = call(&state, "settings.patch", json!({"patch": {"a": 3}, "baseVersion": first["version"]})).await;
        assert_eq!(stale, Err("errors.settingsConflict".to_string()));
        assert_eq!(call(&state, "settings.patch", json!({"patch": [1]})).await, Err("errors.settingsInvalid".to_string()));
        assert_eq!(call(&state, "settings.replace", json!({"values": "x"})).await, Err("errors.settingsInvalid".to_string()));
        assert_eq!(call(&state, "settings.patch", json!({})).await, Err("errors.settingsInvalid".to_string()));
        assert_eq!(on_disk(&dir), json!({"a": 2}));
    }

    #[tokio::test]
    async fn every_change_emits_key_names_and_the_version_never_a_value() {
        let (_dir, state) = rig();
        let mut rx = state.events.subscribe();
        let secret = "alice@example.test Folder/Private";
        let change = call(&state, "settings.replace", json!({"values": {"mailvault-settings": {"state": {"lastMailbox": secret}}}})).await.unwrap();
        let line = rx.try_recv().expect("an event");
        assert!(!line.contains("alice"), "the event carries no value: {line}");
        let (name, payload) = mailvault_core::daemon_ipc::parse_event(&line).unwrap();
        assert_eq!(name, CHANGED_EVENT);
        assert_eq!(payload, json!({"keys": ["mailvault-settings"], "version": change["version"]}));
        // A write that changes nothing is silent.
        call(&state, "settings.replace", json!({"values": {"mailvault-settings": {"state": {"lastMailbox": secret}}}})).await.unwrap();
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn stale_ui_delta_preserves_concurrent_scheduler_fields_and_explicit_removal() {
        let (dir, state) = rig();
        let original = json!({"state":{"language":"en","obsolete":null,"backupHistory":{},"backupState":{},"snapshotLastTimes":{}},"version":3});
        call(&state, "settings.replace", json!({"values":{"mailvault-settings":original}})).await.unwrap();
        call(&state, "settings.patch", json!({"patch":{"mailvault-settings":{"state":{"backupHistory":{"one":[{"success":true}]},"backupState":{"one":{"lastBackupTime":42}},"snapshotLastTimes":{"one":42}}}}})).await.unwrap();
        let edited = json!({"state":{"language":"de","backupHistory":{},"backupState":{},"snapshotLastTimes":{},"literalNull":null},"version":3});
        let result = call(&state, "settings.replace", json!({"values":{"mailvault-settings":edited},"bases":{"mailvault-settings":original}})).await.unwrap();
        let disk = on_disk(&dir);
        assert_eq!(disk["mailvault-settings"]["state"]["backupHistory"]["one"], json!([{"success":true}]));
        assert_eq!(disk["mailvault-settings"]["state"]["backupState"]["one"]["lastBackupTime"], 42);
        assert_eq!(disk["mailvault-settings"]["state"]["snapshotLastTimes"]["one"], 42);
        assert_eq!(disk["mailvault-settings"]["state"]["language"], "de");
        assert!(disk["mailvault-settings"]["state"].get("obsolete").is_none());
        assert_eq!(disk["mailvault-settings"]["state"].get("literalNull"), Some(&Value::Null));
        assert_eq!(disk["mailvault-settings"]["version"], 3);
        assert_eq!(result["values"], disk);
    }

    #[test]
    fn the_route_logs_no_values() {
        let src = include_str!("settings.rs");
        let code = &src[..src.find("#[cfg(test)]").unwrap()];
        for line in code.lines().filter(|l| l.contains("info!") || l.contains("warn!") || l.contains("error!")) {
            assert!(!line.contains("params") && !line.contains("values") && !line.contains("patch)"), "{line}");
        }
    }
}
