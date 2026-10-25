use mailvault_core::backup_schedule::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[test]
fn actual_js_local_date_oracle_is_immutable_and_matches() {
    for (bytes, hash) in [
        (include_bytes!("fixtures/backup-schedule-isolated-UTC.json").as_slice(), "21590eec4c87b0903cde76a6d63d907bdc2f19725f4df40c063c52ae6eb4eb93"),
        (include_bytes!("fixtures/backup-schedule-isolated-Europe-Vilnius.json").as_slice(), "7c232e07a3922375585bb908709561f50467508d2686e6a41b1eaa9a6c3798f8"),
        (include_bytes!("fixtures/backup-schedule-isolated-America-New_York.json").as_slice(), "a2462212b610ead09b9718bc598b4828fb7911ec6174d77001ab38f20f6b01d6"),
    ] {
        assert_eq!(format!("{:x}", Sha256::digest(bytes)), hash);
        let oracle: Value = serde_json::from_slice(bytes).unwrap();
        let zone = oracle["source"]["zone"].as_str().unwrap();
        let cases = oracle["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 632);
        for case in cases.iter().filter(|c| c["category"] == "schedule") {
            let input = &case["input"];
            assert_eq!(next_eligible(&input["accountState"], &input["config"], input["now"].as_i64().unwrap(), zone).unwrap(), case["output"].as_i64().unwrap(), "{zone}: {}", case["name"]);
        }
        for case in cases.iter().filter(|c| c["category"] == "premium") {
            assert_eq!(mailvault_core::cleanup_rules::has_premium_access(&case["input"]["settings"], case["input"]["now"].as_i64().unwrap()), case["output"].as_bool().unwrap());
        }
    }
}
#[test]
fn configuration_rejects_unbounded_or_malformed_local_time_inputs() {
    for patch in [json!({"backupGlobalConfig":{"interval":"weekly","dayOfWeek":7}}), json!({"backupGlobalConfig":{"interval":"daily","timeOfDay":"25:00"}}), json!({"backupSchedules":{"one":{"interval":"weekly","dayOfWeek":"1"}}}), json!({"backupHistory":{}}), json!({"backupMailboxConcurrency":0}), json!({"snapshotCadence":"yearly"})] {
        assert!(validate_patch(&patch).is_err(), "accepted {patch}");
    }
    assert!(validate_patch(&json!({"backupGlobalEnabled":true,"backupSchedules":{"one":{"enabled":true,"interval":"hours","hours":[1,2,2,-1,24]}}})).is_ok());
}
#[test]
fn pure_policy_preserves_gates_overrides_limits_retries_and_snapshots() {
    let now = 1_792_929_600_000;
    let mut settings = json!({"billingProfile":{"hasSubscription":true,"status":"active"},"backupGlobalEnabled":true,"backupGlobalConfig":{"interval":"daily"},"backupSchedules":{"one":{"enabled":false}},"backupMailboxConcurrency":9,"snapshotAutoEnabled":true,"snapshotCadence":"daily","snapshotLastTimes":{"one":1792843200000i64}});
    assert!(scheduled(&settings,"one",now));
    assert!(automatic_due(&settings,"one",now,"UTC",false,now-180000,false).unwrap());
    assert!(!automatic_due(&settings,"one",now,"UTC",true,now-180000,false).unwrap());
    assert!(!automatic_due(&settings,"one",now,"UTC",false,now-179999,false).unwrap());
    assert!(!automatic_due(&settings,"one",now,"UTC",false,now-180000,true).unwrap());
    assert_eq!(mailbox_concurrency(&settings,now),5);
    assert!(snapshot_due(&settings,"one",now,true));
    assert!(!snapshot_due(&settings,"one",now-1,true));
    assert!(!snapshot_due(&settings,"one",now,false));
    settings["billingProfile"] = Value::Null;
    assert!(!scheduled(&settings,"one",now));
    assert_eq!(mailbox_concurrency(&settings,now),1);
    settings["shareGrant"] = json!({"expiresAt":now+1});
    assert!(scheduled(&settings,"one",now));
    settings["hiddenAccounts"] = json!({"one":true}); assert!(!scheduled(&settings,"one",now));
    assert_eq!((0..5).map(|r|retry_delay(r,false)).collect::<Vec<_>>(),vec![Some(30000),Some(120000),Some(300000),None,None]);
    assert_eq!(retry_delay(0,true),None);
    assert_eq!(limit_hold_until(now,None),1_792_972_830_000);
    assert_eq!(limit_hold_until(now,Some(now+1000)),now+31000);
    let cap = json!({"capEnabled":true,"dailyDownLimitBytes":1});
    assert!(download_cap_changed(&cap,&json!({"capEnabled":false,"dailyDownLimitBytes":1})));
    assert!(download_cap_changed(&cap,&json!({"capEnabled":true,"dailyDownLimitBytes":2})));
    assert!(!download_cap_changed(&cap,&json!({"capEnabled":true,"dailyDownLimitBytes":1,"warningEnabled":false,"dailyUpLimitBytes":2})));
}
#[test]
fn explicit_zone_rechecks_fold_and_gap_and_invalid_configuration_is_bounded() {
    assert!(next_eligible(&json!({"lastBackupTime":1}),&json!({"interval":"weekly","dayOfWeek":7}),1,"UTC").is_err());
    assert!(next_eligible(&json!({}),&json!({"interval":"hours","hours":[1]}),1,"Not/AZone").is_err());
    let config = json!({"interval":"hours","hours":[1]});
    assert_ne!(next_eligible(&json!({}),&config,1792929600000,"UTC").unwrap(),next_eligible(&json!({}),&config,1792929600000,"Europe/Vilnius").unwrap());
}
