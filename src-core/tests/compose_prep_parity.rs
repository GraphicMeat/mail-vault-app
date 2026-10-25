use mailvault_core::compose_prep::{self, Context};
use serde_json::{json, Value};
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/compose-prep-cases.json")).unwrap()
}
fn context(f: &Value) -> Context {
    Context {
        accounts: serde_json::from_value(f["accounts"].clone()).unwrap(),
        settings: f["settings"].clone(),
        settings_version: 7,
    }
}
fn message(m: &Value) -> Value {
    let mut header = m.clone();
    let obj = header.as_object_mut().unwrap();
    obj.remove("html");
    obj.remove("text");
    obj.remove("_selectedQuoteHtml");
    obj.remove("_threadContext");
    let mut out = json!({"header":header});
    for key in ["html", "text"] {
        if let Some(v) = m.get(key) {
            out[key] = v.clone();
        }
    }
    out
}
fn request(c: &Value) -> Value {
    let i = &c["input"];
    let m = &i["message"];
    let threads: Vec<Value> = m["_threadContext"].as_array().into_iter().flatten().map(|t| json!({"original":message(t),"dateLabel":format!("date:{}",t["date"].as_str().unwrap_or(""))})).collect();
    json!({"kind":"message","requestId":c["name"],"accountId":"one","pickedFrom":"removed@example.test","mode":i["mode"],"original":message(m),"selectedQuoteHtml":m["_selectedQuoteHtml"],"threadContext":threads,"presentation":{"originalLabel":i["label"],"dateLabel":format!("date:{}",m["date"].as_str().unwrap_or("")),"subjectCandidate":i["subjectCandidate"]}})
}
fn check_request() -> Value {
    json!({"requestId":"check","draftId":"draft-1","revision":3,"accountId":"one","fromAddress":"removed@example.test","mode":"new","forward":false,"to":"ok@example.test","cc":"","bcc":"","subject":"","authoredBodyText":"","attachmentCount":0,"sendPlan":null,"scheduleDraft":null,"timeZone":"UTC","sendAnyway":false})
}
#[test]
fn actual_js_message_fields_match() {
    let f = fixture();
    let ctx = context(&f);
    for c in f["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["category"] == "message")
    {
        let actual = compose_prep::reply_context(&request(c), &ctx).unwrap();
        for (key, expected) in c["output"].as_object().unwrap() {
            assert_eq!(&actual[key], expected, "{} field {key}", c["name"]);
        }
        assert_eq!(actual["requestId"], c["name"]);
        assert_eq!(actual["settingsVersion"], 7);
        assert_eq!(actual["accountId"], "one");
        assert!(
            !actual.to_string().contains("BCC_SENTINEL"),
            "structured Bcc leaked: {}",
            c["name"]
        );
    }
}
#[test]
fn actual_js_mailto_bytes_match() {
    let f = fixture();
    let ctx = context(&f);
    for c in f["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["category"] == "mailto")
    {
        let p = json!({"kind":"mailto","requestId":"mailto","href":c["input"]["href"],"accountId":"two"});
        let out = compose_prep::reply_context(&p, &ctx).unwrap();
        assert_eq!(out["initialData"], c["output"], "{}", c["name"]);
    }
}
#[test]
fn actual_js_validation_and_attachment_policy_match() {
    let f = fixture();
    let mut ctx = context(&f);
    ctx.settings["attachmentReminder"] = json!(true);
    ctx.settings["billingProfile"] = json!({"hasSubscription":true,"status":"active"});
    for c in f["cases"].as_array().unwrap() {
        let mut p = check_request();
        let category = c["category"].as_str().unwrap();
        if category == "invalid" {
            p["to"] = c["input"].clone();
            let out = compose_prep::check(&p, &ctx, 1792886400000).unwrap();
            if p["to"].as_str().unwrap().trim().is_empty() {
                assert_eq!(out["key"], "compose.pleaseEnterLeastOneRecipient");
            } else if let Some(first) = c["output"].as_array().unwrap().first() {
                assert_eq!(out["args"]["address"], *first, "{}", c["name"]);
            } else {
                assert_eq!(out["kind"], "ready", "{}", c["name"]);
            }
        } else if category == "attachment" || category == "authored" {
            let i = &c["input"];
            p["mode"] = i["mode"].clone();
            p["subject"] = i["subject"].clone();
            p["authoredBodyText"] = i["bodyText"].clone();
            p["attachmentCount"] = i["attachmentCount"].clone();
            let out = compose_prep::check(&p, &ctx, 1792886400000).unwrap();
            let expected = if category == "authored" {
                &c["output"]["missing"]
            } else {
                &c["output"]
            };
            assert_eq!(
                out["kind"] == "confirm_attachment",
                expected.as_bool().unwrap(),
                "{}",
                c["name"]
            );
        }
    }
}
#[test]
fn actual_js_route_and_two_pass_timezone_match() {
    let f = fixture();
    let ctx = context(&f);
    for c in f["cases"].as_array().unwrap() {
        let i = &c["input"];
        if c["category"] == "route" {
            let actual = compose_prep::route_send(
                &i["plan"],
                &i["scheduleDraft"],
                i["now"].as_i64().unwrap(),
                i["timeZone"].as_str().unwrap(),
            )
            .unwrap();
            assert_eq!(actual, c["output"], "{}", c["name"]);
        } else if c["category"] == "time" {
            let local = i["localTime"].as_str().unwrap();
            let tz = i["timeZone"].as_str().unwrap();
            let epoch = compose_prep::zoned_time_to_epoch(local, tz).unwrap();
            assert_eq!(json!(epoch), c["output"]["epoch"], "{}", c["name"]);
            assert_eq!(
                compose_prep::wall_clock_at(epoch, tz).unwrap(),
                c["output"]["wall"].as_str().unwrap()
            );
            let mut p = check_request();
            p["sendPlan"] = json!({"kind":"at"});
            p["scheduleDraft"] = json!({"localTime":local,"tz":tz});
            assert_eq!(
                compose_prep::check(&p, &ctx, epoch).unwrap()["key"],
                "scheduled.picker.pastTime"
            );
        }
    }
}
#[test]
fn ordered_check_keeps_snapshot_identity_and_only_suppresses_reminder() {
    let f = fixture();
    let mut ctx = context(&f);
    ctx.settings["attachmentReminder"] = json!(true);
    ctx.settings["billingProfile"] = json!({"hasSubscription":true,"status":"active"});
    let mut p = check_request();
    p["accountId"] = json!("gone");
    p["to"] = json!("");
    p["cc"] = json!("bad-cc");
    p["bcc"] = json!("bad-bcc");
    p["authoredBodyText"] = json!("attached");
    assert_eq!(
        compose_prep::check(&p, &ctx, 0).unwrap()["key"],
        "compose.pleaseEnterLeastOneRecipient"
    );
    p["to"] = json!("bad-to");
    assert_eq!(
        compose_prep::check(&p, &ctx, 0).unwrap()["args"]["address"],
        "bad-to"
    );
    p["to"] = json!("valid@example.test");
    assert_eq!(
        compose_prep::check(&p, &ctx, 0).unwrap()["args"]["address"],
        "bad-cc"
    );
    p["cc"] = json!("");
    assert_eq!(
        compose_prep::check(&p, &ctx, 0).unwrap()["args"]["address"],
        "bad-bcc"
    );
    p["bcc"] = json!("");
    assert_eq!(
        compose_prep::check(&p, &ctx, 0).unwrap()["key"],
        "compose.noAccountSelected"
    );
    p["accountId"] = json!("one");
    p["sendPlan"] = json!({"kind":"at"});
    p["scheduleDraft"] = json!({"localTime":"2000-01-01T00:00","tz":"UTC"});
    assert_eq!(
        compose_prep::check(&p, &ctx, 1792886400000).unwrap()["kind"],
        "confirm_attachment"
    );
    p["sendAnyway"] = json!(true);
    let out = compose_prep::check(&p, &ctx, 1792886400000).unwrap();
    assert_eq!(out["key"], "scheduled.picker.pastTime");
    assert_eq!(out["requestId"], "check");
    assert_eq!(out["draftId"], "draft-1");
    assert_eq!(out["revision"], 3);
    p["sendPlan"] = Value::Null;
    assert_eq!(
        compose_prep::check(&p, &ctx, 0).unwrap()["route"],
        json!({"delay":null})
    );
    p["to"] = json!("changed-invalid");
    assert_eq!(compose_prep::check(&p, &ctx, 0).unwrap()["kind"], "invalid");
}
#[test]
fn malformed_plans_and_untrusted_fields_never_authorize_send() {
    let f = fixture();
    let ctx = context(&f);
    for plan in [
        json!({"kind":"at"}),
        json!({"kind":"in","minutes":-1}),
        json!({"kind":"in","minutes":1441}),
        json!({"kind":"in","minutes":1.5}),
        json!({"kind":"unknown"}),
    ] {
        let mut p = check_request();
        p["sendPlan"] = plan;
        assert!(compose_prep::check(&p, &ctx, 0).is_err());
    }
    for (key, value) in [
        ("timeZone", json!("unknown/zone")),
        ("attachmentCount", json!(-1)),
        ("premium", json!(true)),
        ("account", json!({"password":"secret-sentinel"})),
    ] {
        let mut p = check_request();
        p[key] = value;
        assert!(compose_prep::check(&p, &ctx, 0).is_err());
    }
}
#[test]
fn settings_and_entitlement_are_native_inputs() {
    let f = fixture();
    let mut ctx = context(&f);
    for c in f["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["category"] == "premium")
    {
        let mut p = check_request();
        p["authoredBodyText"] = json!("attached");
        ctx.settings = c["input"]["state"].clone();
        ctx.settings["attachmentReminder"] = json!(true);
        assert_eq!(
            compose_prep::check(&p, &ctx, c["input"]["now"].as_i64().unwrap()).unwrap()["kind"]
                == "confirm_attachment",
            c["output"].as_bool().unwrap(),
            "{}",
            c["name"]
        );
    }
    ctx.settings = json!({"attachmentReminder":false,"billingProfile":{"hasSubscription":true,"status":"active"}});
    let mut p = check_request();
    p["authoredBodyText"] = json!("attached");
    assert_eq!(compose_prep::check(&p, &ctx, 0).unwrap()["kind"], "ready");
}
