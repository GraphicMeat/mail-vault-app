//! The golden corpus: every answer the app's JS gave (tests/fixtures/body-scan-cases.json),
//! given the same way here, field for field and the HTML byte for byte.

use super::*;
use serde_json::{json, Value};

const CASES: &str = include_str!("../../tests/fixtures/body-scan-cases.json");

fn fixture() -> Value {
    serde_json::from_str(CASES).expect("fixture parses")
}

fn texts(f: &Value, locale: &str) -> Texts {
    Texts::from_value(f["texts"].get(locale))
}

fn locale(case: &Value) -> &str {
    case["locale"].as_str().unwrap_or("en")
}

fn report(wrong: Vec<String>, total: usize, what: &str) {
    assert!(wrong.is_empty(), "{} of {total} {what} cases differ from the JS:\n{}", wrong.len(), wrong.join("\n"));
}

#[test]
fn the_table_is_the_one_the_app_shipped() {
    let f = fixture();
    let ours: Vec<Value> = tracker_list::CURATED
        .iter()
        .chain(tracker_list::UGLY_EMAIL)
        .chain(tracker_list::MTB)
        .map(|(label, src)| json!([label, src, "i"]))
        .collect();
    assert_eq!(Value::Array(ours), f["patterns"]);
    assert_eq!(tracker_pattern_count(), f["patterns"].as_array().unwrap().len());
    // Every rule compiles, one by one too (a set hides which one is wrong).
    for (_, src) in tracker_list::CURATED.iter().chain(tracker_list::UGLY_EMAIL).chain(tracker_list::MTB) {
        compile_i(src);
    }
}

#[test]
fn trackers_match_the_js() {
    let f = fixture();
    let cases = f["trackers"].as_array().unwrap();
    let mut wrong = Vec::new();
    for case in cases {
        let html = case["html"].as_str().unwrap();
        let got = scan_trackers(html, &texts(&f, locale(case)));
        let got = json!({
            "trackers": got.trackers,
            "count": got.trackers.len(),
            "https": got.https,
            "cleanedBodyHtml": got.cleaned.as_deref().unwrap_or(html),
        });
        if got != case["expected"] {
            wrong.push(format!("{} [{}]:\n  got  {got}\n  want {}", case["name"], locale(case), case["expected"]));
        }
    }
    report(wrong, cases.len(), "tracker");
}

#[test]
fn links_match_the_js() {
    let f = fixture();
    let cases = f["links"].as_array().unwrap();
    let mut wrong = Vec::new();
    for case in cases {
        let html = case["html"].as_str().unwrap();
        let got = scan_links(html, &texts(&f, locale(case)));
        let got = json!({
            "alerts": got.alerts,
            "modifiedBodyHtml": got.html,
            "maxAlertLevel": got.max_level,
            "styled": !got.alerts.is_empty(),
        });
        if got != case["expected"] {
            wrong.push(format!("{} [{}]:\n  got  {got}\n  want {}", case["name"], locale(case), case["expected"]));
        }
    }
    report(wrong, cases.len(), "link");
}

#[test]
fn classify_matches_the_js() {
    let f = fixture();
    let cases = f["classify"].as_array().unwrap();
    let mut wrong = Vec::new();
    for case in cases {
        let got = serde_json::to_value(classify_link(case["href"].as_str().unwrap(), case["text"].as_str().unwrap(), &texts(&f, locale(case)))).unwrap();
        if got != case["expected"] {
            wrong.push(format!("{} / {} [{}]:\n  got  {got}\n  want {}", case["href"], case["text"], locale(case), case["expected"]));
        }
    }
    report(wrong, cases.len(), "classify");
}

#[test]
fn scannable_matches_the_js() {
    let f = fixture();
    for case in f["scannable"].as_array().unwrap() {
        let href = case["href"].as_str().unwrap();
        assert_eq!(Value::Bool(is_scannable_href(href)), case["expected"], "{href:?}");
    }
}

#[test]
fn the_reader_pipeline_matches_the_js() {
    let f = fixture();
    let t = texts(&f, "en");
    let cases = f["pipeline"].as_array().unwrap();
    let mut wrong = Vec::new();
    for case in cases {
        let html = case["html"].as_str().unwrap();
        let ans = scan_body(html, case["blocking"].as_bool().unwrap(), case["links"].as_bool().unwrap(), &t);
        let got = json!({
            "trackers": ans["trackers"],
            "count": ans["count"],
            "https": ans["https"],
            "html": ans["html"].as_str().unwrap_or(html),
            "alerts": ans["alerts"],
            "maxAlertLevel": ans["maxAlertLevel"],
        });
        if got != case["expected"] {
            wrong.push(format!("{}:\n  got  {got}\n  want {}", case["name"], case["expected"]));
        }
        assert_eq!(ans["summary"]["count"].as_u64().unwrap_or(0), ans["count"].as_u64().unwrap(), "{}", case["name"]);
    }
    report(wrong, cases.len(), "pipeline");
}

#[derive(serde::Deserialize)]
struct TrackerIn {
    vendor: String,
}

impl TrackerIn {
    fn into_tracker(self) -> Tracker {
        Tracker { vendor: self.vendor, known: false, domain: String::new(), url: String::new(), reason: String::new() }
    }
}

#[test]
fn row_alerts_match_the_js() {
    let f = fixture();
    let cases = f["rows"].as_array().unwrap();
    let mut wrong = Vec::new();
    for case in cases {
        let settings = match case.get("settings") {
            Some(s) => RowSettings::from_state(s),
            None => RowSettings { link_safety_enabled: case["linkSafetyEnabled"].as_bool().unwrap(), ..Default::default() },
        };
        let row = &case["row"];
        let got = Value::Object(row_alerts(row, row.get("_key").and_then(Value::as_str), &settings));
        if got != case["expected"] {
            wrong.push(format!("{}:\n  got  {got}\n  want {}", case["name"], case["expected"]));
        }
    }
    report(wrong, cases.len(), "row");
}

#[test]
fn summaries_match_the_js() {
    let f = fixture();
    for case in f["summaries"].as_array().unwrap() {
        let trackers: Vec<Tracker> = serde_json::from_value::<Vec<TrackerIn>>(case["trackers"].clone()).unwrap().into_iter().map(TrackerIn::into_tracker).collect();
        assert_eq!(serde_json::to_value(summarize(&trackers)).unwrap(), case["expected"]);
    }
}

#[test]
fn numbers_are_written_as_javascript_writes_them() {
    for (n, s) in [(1.0, "1"), (1.5, "1.5"), (0.25, "0.25"), (0.0, "0"), (1e-7, "1e-7"), (1.5e-7, "1.5e-7"), (0.000001, "0.000001"), (3.0, "3"), (1e21, "1e+21"), (1e20, "100000000000000000000")] {
        assert_eq!(js_number(n), s);
    }
}

#[test]
fn templates_fill_like_the_apps_t() {
    let t = Texts::from_value(Some(&json!({"k": "{{a}} and {{b}} {{{a}}} {{missing}} {{ a }}"})));
    assert_eq!(t.t("k", &[("a", "1"), ("b", "{{a}}")]), "1 and {{a}} {1} {{missing}} {{ a }}");
    assert_eq!(t.t("absent", &[]), "absent");
}

#[test]
fn decode_is_as_strict_as_decode_uri_component() {
    assert_eq!(decode_uri_component("a%20b+c").as_deref(), Some("a b+c"));
    assert_eq!(decode_uri_component("%E2%82%AC").as_deref(), Some("\u{20AC}"));
    for bad in ["%zz", "%C3%28", "%", "%E2%82", "%ED%A0%80", "%C0%AF"] {
        assert_eq!(decode_uri_component(bad), None, "{bad}");
    }
}

#[test]
fn an_unchanged_body_is_not_rewritten() {
    let body = "<p>Hi<b>unclosed";
    let ans = scan_body(body, true, false, &Texts::default());
    assert_eq!(ans["html"], Value::Null);
    assert_eq!(ans["count"], 0);
}
