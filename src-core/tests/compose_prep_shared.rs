//! What desktop and mobile share in compose preparation: one reply subject rule, one quote,
//! one own-address removal. Mobile calls `reply_context` with an empty settings document and
//! `pickedFrom` set to the account's address; desktop adds aliases and its localized prefix.
use mailvault_core::compose_prep::{quoted_text, reply_context, Account, Context, QuoteLabels};
use serde_json::{json, Value};

fn ctx() -> Context {
    Context {
        accounts: vec![Account { id: "one".into(), email: "me@x.test".into(), ..Account::default() }],
        settings: json!({}),
        settings_version: 0,
    }
}

fn request(mode: &str, subject: &str, candidate: &str, header_extra: Value) -> Value {
    let mut header = json!({"from": {"name": "Ann", "address": "ann@x.test"}, "subject": subject, "date": "d",
        "to": [{"address": "me@x.test"}, {"address": "bob@x.test"}]});
    for (k, v) in header_extra.as_object().into_iter().flatten() {
        header[k] = v.clone();
    }
    json!({"kind": "message", "requestId": "r", "accountId": "one", "pickedFrom": "me@x.test", "mode": mode,
        "original": {"header": header, "text": "line one\nline two"},
        "presentation": {"originalLabel": "Original message", "dateLabel": "today", "subjectCandidate": candidate}})
}

fn subject(mode: &str, original: &str, candidate: &str) -> String {
    let out = reply_context(&request(mode, original, candidate, json!({})), &ctx()).unwrap();
    out["subject"].as_str().unwrap().to_string()
}

#[test]
fn desktop_and_mobile_candidates_give_the_same_subject() {
    // Mobile's candidate is `Re: <subject>` / `Fwd: <subject>`; desktop's is the catalog string.
    let cases: &[(&str, &str, &str)] = &[
        ("reply", "x", "Re: x"),
        ("reply", "Re: RE: x", "Re: x"),
        ("replyAll", "AW: x", "Re: x"),
        ("reply", "Fwd: Re: x", "Re: x"),
        ("reply", "re:x", "Re: x"),
        ("reply", "", "Re:"),
        ("forward", "x", "Fwd: x"),
        ("forward", "Fw: x", "Fwd: x"),
        ("forward", "Fwd: Fwd: x", "Fwd: x"),
        ("forward", "Re: x", "Fwd: x"),
        ("forward", "", "Fwd:"),
    ];
    for (mode, original, want) in cases {
        let prefix = if *mode == "forward" { "Fwd:" } else { "Re:" };
        let mobile = subject(mode, original, &format!("{prefix} {original}"));
        assert_eq!(&mobile, want, "mobile {mode} {original:?}");
        // Desktop with the same English catalog string.
        assert_eq!(subject(mode, original, &format!("{prefix} {original}")), mobile);
    }
}

#[test]
fn a_localized_catalog_prefix_is_kept_and_the_original_is_stripped() {
    assert_eq!(subject("forward", "Re: x", "WG: Re: x"), "WG: x");
    assert_eq!(subject("forward", "WG: x", "WG: WG: x"), "WG: x");
    assert_eq!(subject("reply", "Re : x", "Re : Re : x"), "Re : x");
    assert_eq!(subject("reply", "x", "回复: x"), "回复: x");
    assert_eq!(subject("reply", "回复: x", "回复: 回复: x"), "回复: x");
    assert_eq!(subject("forward", "", "TR : "), "TR :");
}

#[test]
fn own_addresses_leave_the_recipients_for_mobile_and_desktop_alike() {
    let h = json!({"cc": [{"address": "ME@X.TEST"}, {"address": "carol@x.test"}]});
    let out = reply_context(&request("replyAll", "x", "Re: x", h), &ctx()).unwrap();
    let all = format!("{}, {}", out["to"].as_str().unwrap(), out["cc"].as_str().unwrap()).to_lowercase();
    assert!(all.contains("ann@x.test") && all.contains("bob@x.test") && all.contains("carol@x.test"), "{all}");
    assert!(!all.contains("me@x.test"), "{all}");
}

#[test]
fn the_text_quote_carries_the_fields_of_the_html_quote_in_the_same_order() {
    let h = json!({"from": {"name": "Ann", "address": "ann@x.test"}, "subject": "Plans"});
    let labels = QuoteLabels { original: "Original message".into(), from: "From".into(), date: "Date".into(), subject: "Subject".into() };
    let text = quoted_text(&labels, &h, "today", "line one\nline two");
    let out = reply_context(&request("reply", "Plans", "Re: Plans", json!({"from": {"name": "Ann", "address": "ann@x.test"}})), &ctx()).unwrap();
    let html = out["quotedHeaderHtml"].as_str().unwrap();
    for field in ["Original message", "From: Ann", "ann@x.test", "Date:", "Subject: Plans"] {
        assert!(html.contains(field) && text.contains(field), "{field}\n{html}\n{text}");
    }
    let order = |s: &str| ["Original message", "From:", "Date:", "Subject:"].map(|f| s.find(f).unwrap());
    let (t, h) = (order(&text), order(html));
    assert!(t.windows(2).all(|w| w[0] < w[1]) && h.windows(2).all(|w| w[0] < w[1]), "{t:?} {h:?}");
    assert!(text.ends_with("> line one\n> line two\n"), "{text}");
}
