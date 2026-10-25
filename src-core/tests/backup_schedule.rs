use mailvault_core::backup_schedule::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[test]
fn actual_js_local_date_oracle_is_immutable_and_matches() {
    for (bytes, hash) in [
        (include_bytes!("fixtures/backup-schedule-UTC.json").as_slice(), "9f046f86a12971dd7e062a4854d6afae111ce5d9ee881a2df7a1a28b82161f2a"),
        (include_bytes!("fixtures/backup-schedule-Europe-Vilnius.json").as_slice(), "cc986951e37ad597f336dfa790cc0c8c3917f2281cb1e56874b7bb056ff5d731"),
        (include_bytes!("fixtures/backup-schedule-America-New_York.json").as_slice(), "e1e9b660a653d8d6c3d85aace35699c5593ab08e18525a36b4e54846e20f5ec8"),
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
