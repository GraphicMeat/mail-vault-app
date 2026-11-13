//! `mobile.settings.get` / `mobile.settings.set` as the Settings screen and the onboarding use them
//! (plan Ruling 14): notifications, the app language the user picked, and whether the tour is done.

use mailvault_mobile_engine::{Engine, MemorySecrets};
use serde_json::json;
use std::sync::Arc;

fn engine(tmp: &tempfile::TempDir) -> Engine {
    Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(MemorySecrets::default())).unwrap()
}

const LANGUAGES: [&str; 9] = ["en", "es", "fr", "it", "de", "pt-BR", "ja", "ko", "zh-Hans"];

#[test]
fn settings_default_and_round_trip() {
    let tmp = tempfile::tempdir().unwrap();
    let want = json!({ "notifications": "on", "notificationPreview": false, "language": "de", "onboardingComplete": true, "backgroundDownload": false });
    {
        let e = engine(&tmp);
        assert_eq!(
            e.rpc("mobile.settings.get", json!({})).unwrap(),
            json!({ "notifications": "off", "notificationPreview": true, "language": null, "onboardingComplete": false, "backgroundDownload": true })
        );
        assert_eq!(e.rpc("mobile.settings.set", json!({ "notifications": "on" })).unwrap()["notificationPreview"], true, "a partial set keeps the rest");
        assert_eq!(e.rpc("mobile.settings.set", json!({ "notificationPreview": false })).unwrap()["notifications"], "on");
        assert_eq!(e.rpc("mobile.settings.set", json!({ "language": "de" })).unwrap()["language"], "de");
        assert_eq!(e.rpc("mobile.settings.set", json!({ "backgroundDownload": false })).unwrap()["notifications"], "on");
        assert_eq!(e.rpc("mobile.settings.set", json!({ "onboardingComplete": true })).unwrap(), want);
    }
    assert_eq!(engine(&tmp).rpc("mobile.settings.get", json!({})).unwrap(), want, "settings survive a reopen");
}

#[test]
fn every_app_language_is_accepted() {
    let tmp = tempfile::tempdir().unwrap();
    let e = engine(&tmp);
    for code in LANGUAGES {
        assert_eq!(e.rpc("mobile.settings.set", json!({ "language": code })).unwrap()["language"], code);
    }
}

#[test]
fn a_language_outside_the_nine_is_invalid() {
    let tmp = tempfile::tempdir().unwrap();
    let e = engine(&tmp);
    e.rpc("mobile.settings.set", json!({ "language": "fr" })).unwrap();
    let before = e.rpc("mobile.settings.get", json!({})).unwrap();
    for bad in [json!({ "language": "sv" }), json!({ "language": "pt" }), json!({ "language": "DE" }), json!({ "language": "" }), json!({ "language": 3 }), json!({ "onboardingComplete": "yes" })] {
        let err = e.rpc("mobile.settings.set", bad.clone()).unwrap_err();
        assert_eq!(err.code(), "INVALID", "{bad}");
    }
    assert_eq!(e.rpc("mobile.settings.get", json!({})).unwrap(), before, "a refused set changes nothing");
}

#[test]
fn set_setting_checks_language_and_onboarding_too() {
    let tmp = tempfile::tempdir().unwrap();
    let e = engine(&tmp);
    assert!(e.set_setting("language", "klingon").is_err());
    assert!(e.set_setting("onboardingComplete", "maybe").is_err());
    e.set_setting("language", "ja").unwrap();
    e.set_setting("onboardingComplete", "true").unwrap();
    let got = e.rpc("mobile.settings.get", json!({})).unwrap();
    assert_eq!((got["language"].clone(), got["onboardingComplete"].clone()), (json!("ja"), json!(true)));
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
