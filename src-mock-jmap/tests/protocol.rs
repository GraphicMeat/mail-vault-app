// src-mock-jmap/tests/protocol.rs
use mock_jmap::*;
use serde_json::{json, Value};

fn basic() -> String { format!("Basic {}", base64_encode("alice@example.test:pw")) }

fn scenario() -> Scenario {
    Scenario {
        accounts: vec![ScenarioAccount {
            username: "alice@example.test".into(), password: "pw".into(), token: Some("tok".into()),
            identities: vec![("alice@example.test".into(), "Alice".into())],
            mailboxes: vec![
                ScenarioMailbox { id: "mb-inbox".into(), name: "Inbox".into(), parent_id: None, role: Some("inbox".into()),
                    emails: vec![ScenarioEmail { id: "e1".into(), raw: "Message-ID: <e1@x>\r\nSubject: one\r\n\r\nbody".into(),
                        keywords: vec!["$seen".into()], received_at: "2026-10-01T10:00:00Z".into(), also_in: vec!["mb-work".into()] }] },
                ScenarioMailbox { id: "mb-work".into(), name: "Work".into(), parent_id: None, role: None, emails: vec![] },
            ],
        }],
        faults: vec![], limits: Limits::default(),
    }
}

fn post(m: &MockJmap, auth: &str, body: Value) -> (u16, Value) { http_post_json(&format!("{}/jmap/api", m.base_url()), auth, &body) }

#[test]
fn session_requires_auth_and_lists_capabilities() {
    let m = MockJmap::start(scenario());
    assert_eq!(http_get(&m.session_url(), None).0, 401);
    let (code, body) = http_get(&m.session_url(), Some(&basic()));
    assert_eq!(code, 200);
    let s: Value = serde_json::from_str(&body).unwrap();
    assert!(s["capabilities"]["urn:ietf:params:jmap:mail"].is_object());
    assert_eq!(s["primaryAccounts"]["urn:ietf:params:jmap:mail"], "acc1");
}

#[test]
fn well_known_redirects_to_session() {
    let m = MockJmap::start(scenario());
    let (code, location) = http_get_no_follow(&format!("{}/.well-known/jmap", m.base_url()));
    assert_eq!(code, 301);
    assert!(location.ends_with("/jmap/session"));
}

#[test]
fn query_then_get_by_back_reference() {
    let m = MockJmap::start(scenario());
    let (_, r) = post(&m, &basic(), json!({"using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],"methodCalls":[
        ["Email/query",{"accountId":"acc1","filter":{"inMailbox":"mb-work"}},"q"],
        ["Email/get",{"accountId":"acc1","#ids":{"resultOf":"q","name":"Email/query","path":"/ids"},"properties":["mailboxIds","keywords"]},"g"]]}));
    let list = &r["methodResponses"][1][1]["list"];
    assert_eq!(list[0]["id"], "e1");
    assert_eq!(list[0]["mailboxIds"], json!({"mb-inbox":true,"mb-work":true}));
}

#[test]
fn changes_report_keyword_update_and_cannot_calculate_for_unknown_state() {
    let m = MockJmap::start(scenario());
    let (_, r) = post(&m, &basic(), json!({"using":[],"methodCalls":[["Email/get",{"accountId":"acc1","ids":[]},"a"]]}));
    let state = r["methodResponses"][0][1]["state"].as_str().unwrap().to_string();
    m.mutate(|s| s.set_keywords("acc1", "e1", &["$seen", "$flagged"]));
    let (_, r) = post(&m, &basic(), json!({"using":[],"methodCalls":[["Email/changes",{"accountId":"acc1","sinceState":state},"c"]]}));
    assert_eq!(r["methodResponses"][0][1]["updated"], json!(["e1"]));
    let (_, r) = post(&m, &basic(), json!({"using":[],"methodCalls":[["Email/changes",{"accountId":"acc1","sinceState":"bogus"},"c"]]}));
    assert_eq!(r["methodResponses"][0][0], "error");
    assert_eq!(r["methodResponses"][0][1]["type"], "cannotCalculateChanges");
}

#[test]
fn upload_import_and_submission_round_trip() {
    let m = MockJmap::start(scenario());
    let raw = b"From: alice@example.test\r\nTo: bob@example.test\r\nSubject: hi\r\nMessage-ID: <s1@x>\r\n\r\nhello";
    let up: Value = serde_json::from_str(&http_post_bytes(&format!("{}/jmap/upload/acc1/", m.base_url()), &basic(), raw).1).unwrap();
    let blob = up["blobId"].as_str().unwrap();
    // Two requests: an import creation id is not portable as "#k" across servers (RFC 8620 §5.3 covers /set creates only).
    let (_, r) = post(&m, &basic(), json!({"using":[],"methodCalls":[
        ["Email/import",{"accountId":"acc1","emails":{"k":{"blobId":blob,"mailboxIds":{"mb-inbox":true},"keywords":{"$seen":true}}}},"i"]]}));
    let email_id = r["methodResponses"][0][1]["created"]["k"]["id"].as_str().unwrap().to_string();
    let (_, r) = post(&m, &basic(), json!({"using":[],"methodCalls":[
        ["EmailSubmission/set",{"accountId":"acc1","create":{"s":{"emailId":email_id,"identityId":"id1"}},
          "onSuccessUpdateEmail":{"#s":{"keywords/$draft":null}}},"s"]]}));
    assert!(r["methodResponses"][0][1]["created"]["s"]["id"].is_string());
    assert_eq!(m.submitted().len(), 1);
}

#[test]
fn eventsource_pushes_state_change_after_mutation() {
    let m = MockJmap::start(scenario());
    let stream = open_event_stream(&format!("{}/jmap/eventsource/?types=*&closeafter=no&ping=1", m.base_url()), &basic());
    m.mutate(|s| s.set_keywords("acc1", "e1", &[]));
    let ev = stream.next_event(std::time::Duration::from_secs(3)).expect("event");
    assert_eq!(ev.event, "state");
    assert!(ev.data.contains("\"acc1\""));
}

// ── behaviours later tasks rely on ─────────────────────────────────────────

use std::time::Duration;

fn call(m: &MockJmap, calls: Value) -> Value {
    let (code, r) = post(m, &basic(), json!({"using": [], "methodCalls": calls}));
    assert_eq!(code, 200, "{r}");
    r
}

fn email(id: &str, subject: &str, received_at: &str) -> ScenarioEmail {
    ScenarioEmail {
        id: id.into(),
        raw: format!("Message-ID: <{id}@x>\r\nFrom: Bob <bob@example.test>\r\nTo: alice@example.test\r\nSubject: {subject}\r\n\r\nbody of {subject}"),
        keywords: vec![], received_at: received_at.into(), also_in: vec![],
    }
}

fn upload(m: &MockJmap, raw: &[u8]) -> String {
    let (code, body) = http_post_bytes(&format!("{}/jmap/upload/acc1/", m.base_url()), &basic(), raw);
    assert_eq!(code, 201);
    serde_json::from_str::<Value>(&body).unwrap()["blobId"].as_str().unwrap().to_string()
}

fn email_state(m: &MockJmap) -> String {
    call(m, json!([["Email/get",{"accountId":"acc1","ids":[]},"a"]]))["methodResponses"][0][1]["state"].as_str().unwrap().to_string()
}

#[test]
fn bearer_token_authenticates_and_bad_credentials_are_401() {
    let m = MockJmap::start(scenario());
    assert_eq!(http_get(&m.session_url(), Some("Bearer tok")).0, 200);
    assert_eq!(http_get(&m.session_url(), Some("Bearer nope")).0, 401);
    let (code, _) = post(&m, &format!("Basic {}", base64_encode("alice@example.test:wrong")), json!({"using":[],"methodCalls":[]}));
    assert_eq!(code, 401);
}

#[test]
fn session_advertises_limits_submission_and_api_override() {
    let mut s = scenario();
    s.limits.max_objects_in_get = 7;
    s.limits.max_calls_in_request = 3;
    let m = MockJmap::start(s);
    m.mutate(|s| s.api_url_override = Some("http://evil.example/api".into()));
    let s: Value = serde_json::from_str(&http_get(&m.session_url(), Some(&basic())).1).unwrap();
    let core = &s["capabilities"]["urn:ietf:params:jmap:core"];
    assert_eq!(core["maxObjectsInGet"], 7);
    assert_eq!(core["maxCallsInRequest"], 3);
    assert_eq!(core["maxObjectsInSet"], 500);
    assert_eq!(core["maxSizeUpload"], 50_000_000);
    assert!(s["capabilities"]["urn:ietf:params:jmap:submission"].is_object());
    assert_eq!(s["apiUrl"], "http://evil.example/api");
    assert!(s["eventSourceUrl"].as_str().unwrap().contains("types={types}&closeafter={closeafter}&ping={ping}"));
}

#[test]
fn email_get_reports_not_found_ids() {
    let m = MockJmap::start(scenario());
    let r = call(&m, json!([["Email/get",{"accountId":"acc1","ids":["e1","gone"],"properties":["subject","messageId","from"]},"g"]]));
    let g = &r["methodResponses"][0][1];
    assert_eq!(g["list"][0]["subject"], "one");
    assert_eq!(g["list"][0]["messageId"], json!(["e1@x"]));
    assert_eq!(g["list"][0]["from"], Value::Null);
    assert_eq!(g["notFound"], json!(["gone"]));
}

#[test]
fn email_get_over_max_objects_in_get_is_request_too_large() {
    let mut s = scenario();
    s.limits.max_objects_in_get = 1;
    let m = MockJmap::start(s);
    let r = call(&m, json!([["Email/get",{"accountId":"acc1","ids":["e1","e2"]},"g"]]));
    assert_eq!(r["methodResponses"][0][0], "error");
    assert_eq!(r["methodResponses"][0][1]["type"], "requestTooLarge");
}

#[test]
fn query_pages_counts_filters_and_moves_query_state() {
    let m = MockJmap::start(scenario());
    m.mutate(|s| {
        s.add_email("acc1", "mb-inbox", email("e2", "two", "2026-10-02T10:00:00Z"));
        s.add_email("acc1", "mb-inbox", email("e3", "three", "2026-10-03T10:00:00Z"));
    });
    let r = call(&m, json!([
        ["Email/query",{"accountId":"acc1","filter":{"inMailbox":"mb-inbox"},"position":1,"limit":1,"calculateTotal":true},"q"],
        ["Email/get",{"accountId":"acc1","ids":[]},"g"]]));
    let q = &r["methodResponses"][0][1];
    assert_eq!(q["ids"], json!(["e2"])); // receivedAt descending: e3, e2, e1
    assert_eq!(q["total"], 3);
    assert_eq!(q["position"], 1);
    assert_eq!(q["queryState"], r["methodResponses"][1][1]["state"]);
    let ids = |filter: Value| call(&m, json!([["Email/query",{"accountId":"acc1","filter":filter},"q"]]))["methodResponses"][0][1]["ids"].clone();
    assert_eq!(ids(json!({"header":["Message-ID","<e2@x>"]})), json!(["e2"]));
    assert_eq!(ids(json!({"header":["Message-ID","e2@x"]})), json!(["e2"]));
    assert_eq!(ids(json!({"text":"three"})), json!(["e3"]));
    assert_eq!(ids(json!({"subject":"TWO"})), json!(["e2"]));
    assert_eq!(ids(json!({"from":"bob@example.test","inMailbox":"mb-inbox"})), json!(["e3","e2"]));
    assert_eq!(ids(json!({"to":"alice@"})), json!(["e3","e2"]));
    let before = q["queryState"].clone();
    m.mutate(|s| s.set_keywords("acc1", "e3", &["$seen"]));
    let after = call(&m, json!([["Email/query",{"accountId":"acc1"},"q"]]))["methodResponses"][0][1]["queryState"].clone();
    assert_ne!(before, after);
}

#[test]
fn changes_honour_max_changes_and_fold_create_then_destroy() {
    let m = MockJmap::start(scenario());
    let since = email_state(&m);
    m.mutate(|s| {
        s.set_keywords("acc1", "e1", &["$flagged"]);
        s.add_email("acc1", "mb-inbox", email("e2", "two", "2026-10-02T10:00:00Z"));
        s.destroy_email("acc1", "e2"); // created and destroyed inside the window: not reported
        s.add_email("acc1", "mb-work", email("e3", "three", "2026-10-03T10:00:00Z"));
    });
    let all = call(&m, json!([["Email/changes",{"accountId":"acc1","sinceState":since},"c"]]))["methodResponses"][0][1].clone();
    assert_eq!((all["created"].clone(), all["updated"].clone(), all["destroyed"].clone()), (json!(["e3"]), json!(["e1"]), json!([])));
    assert_eq!(all["hasMoreChanges"], false);
    let page = |since: &str| call(&m, json!([["Email/changes",{"accountId":"acc1","sinceState":since,"maxChanges":1},"c"]]))["methodResponses"][0][1].clone();
    let p1 = page(&since);
    assert_eq!(p1["updated"], json!(["e1"]));
    assert_eq!(p1["hasMoreChanges"], true);
    let p2 = page(p1["newState"].as_str().unwrap());
    assert_eq!((p2["created"].clone(), p2["destroyed"].clone()), (json!([]), json!([])));
    assert_eq!(p2["hasMoreChanges"], true);
    let p3 = page(p2["newState"].as_str().unwrap());
    assert_eq!(p3["created"], json!(["e3"]));
    assert_eq!(p3["hasMoreChanges"], false);
    assert_eq!(p3["newState"], json!(email_state(&m)));
}

#[test]
fn pruned_log_and_fault_both_refuse_changes() {
    let m = MockJmap::start(scenario());
    let old = email_state(&m);
    m.mutate(|s| {
        s.set_keywords("acc1", "e1", &["$flagged"]);
        s.prune_log("acc1");
    });
    let r = call(&m, json!([["Email/changes",{"accountId":"acc1","sinceState":old},"c"]]));
    assert_eq!(r["methodResponses"][0][1]["type"], "cannotCalculateChanges");
    let fresh = email_state(&m);
    let r = call(&m, json!([["Email/changes",{"accountId":"acc1","sinceState":fresh},"c"]]));
    assert_eq!(r["methodResponses"][0][0], "Email/changes");
    m.mutate(|s| s.faults.push(Fault::CannotCalculateChanges));
    let r = call(&m, json!([["Email/changes",{"accountId":"acc1","sinceState":fresh},"c"]]));
    assert_eq!(r["methodResponses"][0][1]["type"], "cannotCalculateChanges");
}

#[test]
fn set_patches_and_reports_not_updated_and_not_destroyed() {
    let m = MockJmap::start(scenario());
    let r = call(&m, json!([["Email/set",{"accountId":"acc1",
        "update":{"e1":{"keywords/$flagged":true,"mailboxIds/mb-work":null},"nope":{"keywords/$seen":true}},
        "destroy":["gone"]},"s"]]));
    let s = &r["methodResponses"][0][1];
    assert!(s["updated"].as_object().unwrap().contains_key("e1"));
    assert_eq!(s["notUpdated"]["nope"]["type"], "notFound");
    assert_eq!(s["notDestroyed"]["gone"]["type"], "notFound");
    let e1 = m.read(|s| s.email("acc1", "e1").cloned()).unwrap();
    assert_eq!(e1.keywords.into_iter().collect::<Vec<_>>(), vec!["$flagged", "$seen"]);
    assert_eq!(e1.mailbox_ids.into_iter().collect::<Vec<_>>(), vec!["mb-inbox"]);
    // Full-object replace works; removing the last mailbox is refused (RFC 8621 §4.1.1).
    let r = call(&m, json!([
        ["Email/set",{"accountId":"acc1","update":{"e1":{"mailboxIds":{"mb-work":true},"keywords":{}}}},"s"],
        ["Email/set",{"accountId":"acc1","update":{"e1":{"mailboxIds/mb-work":null}}},"t"]]));
    assert!(r["methodResponses"][0][1]["updated"].as_object().unwrap().contains_key("e1"));
    assert_eq!(r["methodResponses"][1][1]["notUpdated"]["e1"]["type"], "invalidProperties");
    let e1 = m.read(|s| s.email("acc1", "e1").cloned()).unwrap();
    assert!(e1.keywords.is_empty());
    assert_eq!(e1.mailbox_ids.into_iter().collect::<Vec<_>>(), vec!["mb-work"]);
    let r = call(&m, json!([["Email/set",{"accountId":"acc1","destroy":["e1"]},"d"]]));
    assert_eq!(r["methodResponses"][0][1]["destroyed"], json!(["e1"]));
    assert!(m.read(|s| s.email("acc1", "e1").is_none()));
}

#[test]
fn import_already_exists_returns_existing_id() {
    let mut s = scenario();
    s.faults.push(Fault::ImportAlreadyExists);
    let m = MockJmap::start(s);
    let blob = upload(&m, b"Message-ID: <e1@x>\r\nSubject: one again\r\n\r\nbody");
    let r = call(&m, json!([["Email/import",{"accountId":"acc1","emails":{"k":{"blobId":blob,"mailboxIds":{"mb-inbox":true}}}},"i"]]));
    let nc = &r["methodResponses"][0][1]["notCreated"]["k"];
    assert_eq!(nc["type"], "alreadyExists");
    assert_eq!(nc["existingId"], "e1");
}

#[test]
fn import_repairs_changes_blob_and_size() {
    let mut s = scenario();
    s.faults.push(Fault::ImportRepairs);
    let m = MockJmap::start(s);
    let raw = b"Message-ID: <r1@x>\r\nSubject: r\r\n\r\nbody";
    let blob = upload(&m, raw);
    let r = call(&m, json!([["Email/import",{"accountId":"acc1","emails":{"k":{"blobId":blob,"mailboxIds":{"mb-inbox":true},"receivedAt":"2026-10-05T00:00:00Z"}}},"i"]]));
    let c = &r["methodResponses"][0][1]["created"]["k"];
    assert_ne!(c["blobId"], json!(blob));
    assert_eq!(c["size"], raw.len() + 2);
    let id = c["id"].as_str().unwrap();
    assert_eq!(m.read(|s| s.email("acc1", id).unwrap().received_at.clone()), "2026-10-05T00:00:00Z");
}

#[test]
fn submission_applies_on_success_update_and_records_raw() {
    let m = MockJmap::start(scenario());
    let blob = upload(&m, b"From: alice@example.test\r\nTo: bob@example.test\r\nSubject: hi\r\nMessage-ID: <s2@x>\r\n\r\nhello");
    let r = call(&m, json!([["Email/import",{"accountId":"acc1","emails":{"k":{"blobId":blob,"mailboxIds":{"mb-work":true},"keywords":{"$draft":true,"$seen":true}}}},"i"]]));
    let id = r["methodResponses"][0][1]["created"]["k"]["id"].as_str().unwrap().to_string();
    let r = call(&m, json!([["EmailSubmission/set",{"accountId":"acc1","create":{"s":{"emailId":id,"identityId":"id1"}},
        "onSuccessUpdateEmail":{"#s":{"mailboxIds/mb-work":null,"mailboxIds/mb-inbox":true,"keywords/$draft":null}}},"s"]]));
    assert_eq!(r["methodResponses"][1][0], "Email/set");
    assert_eq!(r["methodResponses"][1][2], "s");
    assert!(r["methodResponses"][1][1]["updated"].as_object().unwrap().contains_key(&id));
    let e = m.read(|s| s.email("acc1", &id).cloned()).unwrap();
    assert_eq!(e.mailbox_ids.into_iter().collect::<Vec<_>>(), vec!["mb-inbox"]);
    assert_eq!(e.keywords.into_iter().collect::<Vec<_>>(), vec!["$seen"]);
    assert!(m.submitted()[0].starts_with(b"From: alice@example.test"));
    assert!(m.requests().iter().any(|q| q.calls == ["EmailSubmission/set"] && !q.body_contains("envelope")));
}

#[test]
fn rejected_submission_is_forbidden_from_and_sends_nothing() {
    let mut s = scenario();
    s.faults.push(Fault::SubmissionRejected);
    let m = MockJmap::start(s);
    let r = call(&m, json!([["EmailSubmission/set",{"accountId":"acc1","create":{"s":{"emailId":"e1","identityId":"id1"}},
        "onSuccessUpdateEmail":{"#s":{"keywords/$draft":null}}},"s"]]));
    assert_eq!(r["methodResponses"][0][1]["notCreated"]["s"]["type"], "forbiddenFrom");
    assert_eq!(r["methodResponses"].as_array().unwrap().len(), 1);
    assert!(m.submitted().is_empty());
}

#[test]
fn mailbox_set_create_update_destroy_and_changes() {
    let m = MockJmap::start(scenario());
    let since = call(&m, json!([["Mailbox/get",{"accountId":"acc1","ids":[]},"g"]]))["methodResponses"][0][1]["state"].as_str().unwrap().to_string();
    let r = call(&m, json!([["Mailbox/set",{"accountId":"acc1",
        "create":{"p":{"name":"Projects","parentId":null},"c":{"name":"Sub","parentId":"#p"}},
        "update":{"mb-work":{"name":"Jobs"}}},"s"]]));
    let s = &r["methodResponses"][0][1];
    let p = s["created"]["p"]["id"].as_str().unwrap().to_string();
    let c = s["created"]["c"]["id"].as_str().unwrap().to_string();
    assert!(s["updated"].as_object().unwrap().contains_key("mb-work"));
    assert_ne!(s["newState"], json!(since));
    let ch = call(&m, json!([["Mailbox/changes",{"accountId":"acc1","sinceState":since},"c"]]))["methodResponses"][0][1].clone();
    assert_eq!(ch["created"], json!([p.clone(), c.clone()]));
    assert_eq!(ch["updated"], json!(["mb-work"]));
    assert_eq!(ch["updatedProperties"], Value::Null);
    let got = call(&m, json!([["Mailbox/get",{"accountId":"acc1","ids":[c.clone()]},"g"]]));
    assert_eq!(got["methodResponses"][0][1]["list"][0]["parentId"], json!(p));
    // e1 is in mb-work: destroying it needs onDestroyRemoveEmails, and then e1 only loses that label.
    let r = call(&m, json!([["Mailbox/set",{"accountId":"acc1","destroy":["mb-work"]},"d"]]));
    assert_eq!(r["methodResponses"][0][1]["notDestroyed"]["mb-work"]["type"], "mailboxHasEmail");
    let r = call(&m, json!([["Mailbox/set",{"accountId":"acc1","destroy":["mb-work", p.clone()],"onDestroyRemoveEmails":true},"d"]]));
    assert_eq!(r["methodResponses"][0][1]["destroyed"], json!(["mb-work"]));
    assert_eq!(r["methodResponses"][0][1]["notDestroyed"][&p]["type"], "mailboxHasChild");
    let e1 = m.read(|s| s.email("acc1", "e1").cloned()).unwrap();
    assert_eq!(e1.mailbox_ids.into_iter().collect::<Vec<_>>(), vec!["mb-inbox"]);
}

#[test]
fn too_many_calls_is_a_limit_request_error() {
    let mut s = scenario();
    s.limits.max_calls_in_request = 1;
    let m = MockJmap::start(s);
    let (code, r) = post(&m, &basic(), json!({"using":[],"methodCalls":[["Core/echo",{},"a"],["Core/echo",{},"b"]]}));
    assert_eq!(code, 400);
    assert_eq!(r["type"], "urn:ietf:params:jmap:error:limit");
    assert_eq!(r["limit"], "maxCallsInRequest");
}

#[test]
fn rate_limit_answers_429_once_then_recovers() {
    let mut s = scenario();
    s.faults.push(Fault::RateLimited { retry_after_secs: 7 });
    let m = MockJmap::start(s);
    assert_eq!(http_get(&m.session_url(), Some(&basic())).0, 200);
    let auth = basic();
    let body = json!({"using":[],"methodCalls":[["Core/echo",{"x":1},"a"]]});
    let r = http_request("POST", &format!("{}/jmap/api", m.base_url()), &[("Authorization", auth.as_str())], body.to_string().as_bytes());
    assert_eq!(r.status, 429);
    assert_eq!(r.header("Retry-After"), Some("7"));
    let (code, r) = post(&m, &auth, body);
    assert_eq!(code, 200);
    assert_eq!(r["methodResponses"][0][1]["x"], 1);
}

#[test]
fn server_fail_unknown_account_and_bad_reference_are_method_errors() {
    let mut s = scenario();
    s.faults.push(Fault::ServerFail { method: "Identity/get".into() });
    let m = MockJmap::start(s);
    let r = call(&m, json!([
        ["Identity/get",{"accountId":"acc1"},"a"],
        ["Email/get",{"accountId":"acc9","ids":[]},"b"],
        ["Email/get",{"accountId":"acc1","#ids":{"resultOf":"zz","name":"Email/query","path":"/ids"}},"c"],
        ["Mailbox/get",{"accountId":"acc1"},"m"],
        ["Mailbox/get",{"accountId":"acc1","#ids":{"resultOf":"m","name":"Mailbox/get","path":"/list/*/id"},"properties":["name"]},"n"]]));
    let resp = &r["methodResponses"];
    assert_eq!(resp[0][1]["type"], "serverFail");
    assert_eq!(resp[1][1]["type"], "accountNotFound");
    assert_eq!(resp[2][1]["type"], "invalidResultReference");
    assert_eq!(resp[4][1]["list"].as_array().unwrap().len(), 2);
    assert_eq!(resp[4][1]["list"][0].as_object().unwrap().len(), 2); // id + name
}

#[test]
fn download_moves_to_the_second_host_with_a_query_template() {
    let m = MockJmap::start(scenario());
    let blob = m.read(|s| s.email("acc1", "e1").unwrap().blob_id.clone());
    let main = format!("{}/jmap/download/acc1/{blob}/m.eml?type=message/rfc822", m.base_url());
    assert_eq!(http_get_bytes(&main, Some(&basic())).0, 200);
    m.mutate(|s| s.download_host = Some("second".into()));
    let s: Value = serde_json::from_str(&http_get(&m.session_url(), Some(&basic())).1).unwrap();
    let tpl = s["downloadUrl"].as_str().unwrap().to_string();
    assert!(tpl.starts_with(&format!("http://127.0.0.1:{}/", m.download_port())));
    assert!(tpl.ends_with("?type={type}"));
    let url = tpl.replace("{accountId}", "acc1").replace("{blobId}", &blob).replace("{name}", "m.eml").replace("{type}", "message%2Frfc822");
    let (code, bytes) = http_get_bytes(&url, Some(&basic()));
    assert_eq!(code, 200);
    assert!(bytes.starts_with(b"Message-ID: <e1@x>"));
    assert_eq!(http_get_bytes(&main, Some(&basic())).0, 404);
    assert!(m.requests().iter().any(|r| r.download_listener));
}

#[test]
fn requests_record_method_names() {
    let m = MockJmap::start(scenario());
    call(&m, json!([["Email/query",{"accountId":"acc1"},"q"],
        ["Email/get",{"accountId":"acc1","#ids":{"resultOf":"q","name":"Email/query","path":"/ids"}},"g"]]));
    let api: Vec<RecordedRequest> = m.requests().into_iter().filter(|r| r.is_api()).collect();
    assert_eq!(api.len(), 1);
    assert_eq!(api[0].calls, ["Email/query", "Email/get"]);
    assert!(api[0].body_contains("resultOf"));
    assert_eq!(m.count_calls("Email/get"), 1);
}

#[test]
fn eventsource_pings_and_goes_silent_under_drop_fault() {
    let m = MockJmap::start(scenario());
    let url = format!("{}/jmap/eventsource/?types=*&closeafter=no&ping=1", m.base_url());
    let live = open_event_stream(&url, &basic());
    assert_eq!(live.next_any_event(Duration::from_secs(3)).map(|e| e.event), Some("ping".to_string()));
    m.mutate(|s| s.faults.push(Fault::DropEventSourceAfter { events: 0 }));
    let dead = open_event_stream(&url, &basic());
    assert_eq!(dead.status, 200);
    m.mutate(|s| s.set_keywords("acc1", "e1", &[]));
    assert!(dead.next_any_event(Duration::from_millis(2500)).is_none());
    assert_eq!(live.next_event(Duration::from_secs(3)).map(|e| e.event), Some("state".to_string()));
}

#[test]
fn eventsource_resends_unchanged_state_on_empty_mutate() {
    let m = MockJmap::start(scenario());
    let s = open_event_stream(&format!("{}/jmap/eventsource/?types=Email&closeafter=no&ping=0", m.base_url()), &basic());
    m.mutate(|_| {});
    let a = s.next_event(Duration::from_secs(3)).expect("first event");
    m.mutate(|_| {});
    let b = s.next_event(Duration::from_secs(3)).expect("second event");
    assert_eq!(a.data, b.data);
    assert!(!a.data.contains("Mailbox"));
}

#[test]
fn api_writes_push_a_state_event() {
    let m = MockJmap::start(scenario());
    let s = open_event_stream(&format!("{}/jmap/eventsource/?types=*&closeafter=no&ping=0", m.base_url()), &basic());
    let before = email_state(&m);
    call(&m, json!([["Email/set",{"accountId":"acc1","update":{"e1":{"keywords/$flagged":true}}},"s"]]));
    let ev = s.next_event(Duration::from_secs(3)).expect("state event");
    assert!(!ev.data.contains(&format!("\"Email\":\"{before}\"")));
    assert!(ev.data.contains(&format!("\"Email\":\"{}\"", email_state(&m))));
}

#[test]
fn control_routes_deliver_and_report_submissions() {
    let m = MockJmap::start(scenario());
    let r = http_request("POST", &format!("{}/_mock/deliver/acc1/mb-inbox?keywords=$flagged", m.base_url()), &[], b"Message-ID: <d1@x>\r\nTo: a@x.test\r\n\r\nhi");
    assert_eq!(r.status, 200);
    let id = r.json()["id"].as_str().unwrap().to_string();
    assert!(m.read(|s| s.email("acc1", &id).unwrap().keywords.contains("$flagged")));
    assert_eq!(http_get(&format!("{}/_mock/submitted", m.base_url()), None), (200, "[]".to_string()));
    assert_eq!(http_request("POST", &format!("{}/_mock/deliver/acc1/nope", m.base_url()), &[], b"x").status, 404);
}
