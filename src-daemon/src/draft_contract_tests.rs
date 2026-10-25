//! Row 12 initial native RED reaches the existing real RPC dispatcher.
//! No draft implementation or fake dispatcher is installed for this test.
use crate::{ipc, server::{handle_request_for_test, DaemonState}};
use serde_json::{json, Value};

#[tokio::test]
async fn drafts_save_refuses_incomplete_source_snapshot_before_local_effects() {
    let fixture: Value = serde_json::from_str(include_str!("../../src-core/tests/fixtures/local-draft-cases.json")).unwrap();
    let observed = fixture["cases"].as_array().unwrap().iter()
        .find(|case| case["name"] == "no-recipients").unwrap();
    let mut snapshot = observed["input"]["payload"].clone();
    snapshot.as_object_mut().unwrap().remove("attachments");
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("vault");
    let app = dir.path().join("app");
    std::fs::create_dir_all(&vault).unwrap();
    std::fs::create_dir_all(&app).unwrap();
    let state = DaemonState::for_test(vault, app, true);
    let response = handle_request_for_test(&state, "drafts.save", json!({
        "draftId": "row12-complete-contract", "revision": 1,
        "accountId": "one", "fromAddress": "alias@example.test", "displayName": "Alias",
        "snapshot": snapshot, "snippet": ""
    })).await;
    let error = response.error.expect("partial snapshot must be rejected, never acknowledged as an empty draft");
    assert_eq!(error.code, ipc::INVALID_PARAMS,
        "drafts.save must validate completeness before account/storage work; actual error: {}", error.message);
    assert!(error.message.contains("attachments"), "missing complete field must be named: {}", error.message);
}
