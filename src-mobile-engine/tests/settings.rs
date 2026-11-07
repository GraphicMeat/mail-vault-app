//! `mobile.settings.get` / `mobile.settings.set` as the Settings screen uses them (plan Ruling 14).

use mailvault_mobile_engine::{Engine, MemorySecrets};
use serde_json::json;
use std::sync::Arc;

fn engine(tmp: &tempfile::TempDir) -> Engine {
    Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(MemorySecrets::default())).unwrap()
}

#[test]
fn settings_default_and_round_trip() {
    let tmp = tempfile::tempdir().unwrap();
    let want = json!({ "notifications": "on", "notificationPreview": false });
    {
        let e = engine(&tmp);
        assert_eq!(e.rpc("mobile.settings.get", json!({})).unwrap(), json!({ "notifications": "off", "notificationPreview": true }));
        assert_eq!(e.rpc("mobile.settings.set", json!({ "notifications": "on" })).unwrap()["notificationPreview"], true, "a partial set keeps the rest");
        assert_eq!(e.rpc("mobile.settings.set", json!({ "notificationPreview": false })).unwrap(), want);
    }
    assert_eq!(engine(&tmp).rpc("mobile.settings.get", json!({})).unwrap(), want, "settings survive a reopen");
}

#[test]
fn an_unknown_setting_is_invalid() {
    let tmp = tempfile::tempdir().unwrap();
    let e = engine(&tmp);
    let before = e.rpc("mobile.settings.get", json!({})).unwrap();
    for bad in [json!({ "volume": "11" }), json!({ "notifications": "on", "volume": 1 }), json!({ "key": "notifications", "value": "on" })] {
        let err = e.rpc("mobile.settings.set", bad.clone()).unwrap_err();
        assert_eq!(err.code(), "INVALID", "{bad}");
    }
    assert_eq!(e.rpc("mobile.settings.get", json!({})).unwrap(), before, "a refused set changes nothing");
}
