use mailvault_render::dark::modify_css::{
    bg_image_modifier, get_css_url_value, inline_override_style, modifiable_declaration, shadow_modifier, static_sheets, user_agent_style,
    variables_style, DeclValue, RuleStyle,
};
use mailvault_render::dark::{DarkCx, Profile, Theme};
use serde_json::Value;
use std::collections::HashMap;

fn vectors() -> Value {
    let p = format!("{}/tests/fixtures/dr/vectors.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}
fn theme(v: &Value, name: &str) -> Theme {
    serde_json::from_value(v["themes"][name].clone()).unwrap()
}

struct FakeRule(HashMap<String, String>);
impl RuleStyle for FakeRule {
    fn get_property_value(&self, p: &str) -> String { self.0.get(p).cloned().unwrap_or_default() }
    fn get_property_priority(&self, _: &str) -> bool { false }
}

#[test]
fn declarations_match_dark_reader() {
    let v = vectors();
    let mut cxs: HashMap<String, DarkCx> = HashMap::new();
    for case in v["declarations"].as_array().unwrap() {
        let name = case["theme"].as_str().unwrap().to_string();
        let cx = cxs.entry(name.clone()).or_insert_with(|| DarkCx::new(theme(&v, &name), Profile::WEBKIT_IFRAME));
        let rule = FakeRule(serde_json::from_value(case["ruleStyle"].clone()).unwrap());
        let (p, val) = (case["property"].as_str().unwrap(), case["value"].as_str().unwrap());
        let got = modifiable_declaration(p, val, &rule, cx);
        match &case["out"] {
            Value::Null => assert!(got.is_none(), "{name} {p}: {val} -> {got:?}"),
            out => {
                let got = got.unwrap_or_else(|| panic!("{name} {p}: {val} -> None"));
                assert_eq!(got.property, out["property"].as_str().unwrap(), "{p}: {val}");
                assert_eq!(got.value, DeclValue::Text(out["value"].as_str().unwrap().to_string()), "{name} {p}: {val}");
                assert_eq!(got.important, out["important"].as_bool().unwrap());
            }
        }
    }
}

#[test]
fn static_sheets_match_dark_reader_byte_for_byte() {
    let v = vectors();
    for case in v["static"].as_array().unwrap() {
        let name = case["theme"].as_str().unwrap();
        let mut cx = DarkCx::new(theme(&v, name), Profile::WEBKIT_IFRAME);
        assert_eq!(user_agent_style(&mut cx), case["userAgent"].as_str().unwrap(), "{name} user-agent");
        assert_eq!(inline_override_style(), case["inline"].as_str().unwrap());
        assert_eq!(variables_style(&mut cx), case["variables"].as_str().unwrap(), "{name} variables");
    }
}

#[test]
fn top_level_profile_paints_the_html_background() {
    let mut cx = DarkCx::new(Theme::mailvault("#0a0a12", "#e8e8ef", 100.0, 100.0, 0.0), Profile { is_iframe: false, ..Profile::WEBKIT_IFRAME });
    let ua = user_agent_style(&mut cx);
    assert!(ua.contains("html {\n    background-color: var(--darkreader-background-ffffff, #0a0a12) !important;\n}"));
    assert!(ua.contains("html, body {\n    background-color: var(--darkreader-background-ffffff, #0a0a12);\n}"));
}

fn indigo_cx() -> DarkCx {
    DarkCx::new(Theme::mailvault("#0a0a12", "#e8e8ef", 100.0, 100.0, 0.0), Profile::WEBKIT_IFRAME)
}

#[test]
fn css_url_values_lose_wrapper_quotes_and_line_breaks() {
    assert_eq!(get_css_url_value(" url('a.png') "), "a.png");
    assert_eq!(get_css_url_value("url(\"b c.png\")"), "b c.png");
    assert_eq!(get_css_url_value("url(c.png)"), "c.png");
    assert_eq!(get_css_url_value("url(\"d\n.png\")"), "d.png");
    assert_eq!(get_css_url_value("url()"), "");
}

#[test]
fn url_backgrounds_keep_their_url_and_empty_ones_stay_empty() {
    let mut cx = indigo_cx();
    let rule = FakeRule(HashMap::new());
    assert_eq!(bg_image_modifier("url(x.png)", &rule, &mut cx).as_deref(), Some("url(\"x.png\")"));
    assert_eq!(bg_image_modifier("url('')", &rule, &mut cx).as_deref(), Some("url('')"));
    assert_eq!(bg_image_modifier("none", &rule, &mut cx).as_deref(), Some("none"));
}

#[test]
fn shadow_modifier_counts_matches_and_unparsables() {
    let mut cx = indigo_cx();
    let r = shadow_modifier("0 1px 2px rgba(0, 0, 0, 0.5)", &mut cx).unwrap();
    assert_eq!((r.matches, r.unparsable), (1, 0));
    assert!(r.result.starts_with("0 1px 2px var(--darkreader-background-"), "{}", r.result);
    let r = shadow_modifier("0 0 3px notacolour", &mut cx).unwrap();
    assert_eq!((r.matches, r.unparsable), (1, 1));
    assert_eq!(r.result, "0 0 3px notacolour");
}

#[test]
fn static_sheets_join_the_three_sheets_and_list_every_registered_colour() {
    let mut cx = indigo_cx();
    let rule = FakeRule(HashMap::new());
    modifiable_declaration("color", "rgb(51, 51, 51)", &rule, &mut cx).unwrap();
    modifiable_declaration("border-top-color", "rgb(1, 2, 3)", &rule, &mut cx).unwrap();
    let out = static_sheets(&mut cx);
    assert!(out.starts_with("@layer {\nhtml {\n    color-scheme: dark !important;"));
    assert!(out.contains("[data-darkreader-inline-bgcolor] {\n  background-color: var(--darkreader-inline-bgcolor) !important;\n}"));
    let root = &out[out.rfind(":root {").unwrap()..];
    assert!(root.starts_with(":root {\n   --darkreader-neutral-background: "));
    for var in ["--darkreader-text-333333: #", "--darkreader-border-010203: #", "--darkreader-background-ffffff: #0a0a12;"] {
        assert!(root.contains(var), "{var} missing from {root}");
    }
    assert!(root.ends_with(";\n}"));
}
