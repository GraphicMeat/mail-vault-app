//! CSS custom properties through Dark Reader's VariablesStore (plan B Task 15).
use mailvault_render::dark::{debug_sync_css, DarkTheme};
use mailvault_render::inspect::InspectedElement;
use mailvault_render::{RenderDoc, RenderOptions};
use serde_json::Value;

fn indigo() -> DarkTheme {
    DarkTheme { bg: "#0a0a12".into(), fg: "#e8e8ef".into(), brightness: 100.0, contrast: 100.0, sepia: 0.0, top_level: false }
}

#[test]
fn var_cases_match_dark_reader() {
    let p = format!("{}/tests/fixtures/dr/vectors.json", env!("CARGO_MANIFEST_DIR"));
    let v: Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    let cases = v["varCases"].as_array().unwrap();
    assert!(cases.len() >= 8, "vectors lack the var cases (regenerate: Task 15)");
    for case in cases {
        let html = format!("<html><head><style>{}</style></head><body></body></html>", case["css"].as_str().unwrap());
        let got = debug_sync_css(&html, &indigo());
        let want: Vec<String> = case["lines"].as_array().unwrap().iter().map(|l| l.as_str().unwrap().to_string()).collect();
        assert_eq!(got.concat().lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect::<Vec<_>>(), want, "{}", case["id"]);
    }
}

fn dark(body: &str) -> Vec<InspectedElement> {
    let html = format!("<!doctype html><html><head><style>body{{margin:0;background:#ffffff;color:#333333}}</style></head><body>{body}</body></html>");
    RenderDoc::open(&html, RenderOptions { css_width: 600, scale: 1.0, dark: Some(indigo()), ..Default::default() }, None).unwrap().inspect()
}
fn get<'a>(els: &'a [InspectedElement], id: &str) -> &'a InspectedElement {
    els.iter().find(|e| e.mv_id == id).unwrap()
}

#[test]
fn var_chain_resolves_background_type() {
    let els = dark("<style>:root{--brand:#ffffff;--card:var(--brand)}.card{background:var(--card)}</style><div class=\"card\" data-mv-id=\"c\">x</div>");
    assert_eq!(get(&els, "c").background_color, Some([10.0, 10.0, 18.0, 1.0])); // bg(#fff), not fg(#fff)
}

#[test]
fn undefined_var_uses_the_modified_fallback() {
    let els = dark("<style>.b{background-color:var(--missing, #ffcc00)}</style><span class=\"b\" data-mv-id=\"b\">x</span>");
    assert_eq!(get(&els, "b").background_color, Some([153.0, 122.0, 0.0, 1.0])); // bg(#ffcc00) = #997a00
}

#[test]
fn inline_custom_property_is_typed_by_its_use() {
    let els = dark(r#"<div data-mv-id="d" style="--local:#0066cc;color:var(--local)">x</div>"#);
    assert_eq!(get(&els, "d").color, Some([84.0, 178.0, 255.0, 1.0])); // fg(#0066cc) = #54b2ff
}

#[test]
fn one_var_used_as_text_and_background_gets_both() {
    let els = dark("<style>:root{--c:#333333}.a{color:var(--c)}.b{background-color:var(--c)}</style><p class=\"a\" data-mv-id=\"a\">x</p><p class=\"b\" data-mv-id=\"b\">y</p>");
    assert_eq!(get(&els, "a").color, Some([187.0, 187.0, 208.0, 1.0])); // fg(#333333) = #bbbbd0
    assert_eq!(get(&els, "b").background_color, Some([29.0, 29.0, 52.0, 1.0])); // bg(#333333) = #1d1d34
}

#[test]
fn raw_rgb_variable_is_modified_as_a_list() {
    let els = dark("<style>:root{--rgb:0, 102, 204}.x{color:rgb(var(--rgb))}</style><p class=\"x\" data-mv-id=\"x\">x</p>");
    assert_eq!(get(&els, "x").color, Some([84.0, 178.0, 255.0, 1.0])); // fg(0, 102, 204) = #54b2ff
}

#[test]
fn a_variable_set_on_html_reaches_the_root_vars_sheet() {
    let html = "<!doctype html><html style=\"--page:#ffffff\"><head><style>body{margin:0}.c{background:var(--page)}</style></head><body><div class=\"c\" data-mv-id=\"c\">x</div></body></html>";
    let opts = RenderOptions { css_width: 600, scale: 1.0, dark: Some(indigo()), ..Default::default() };
    let els = RenderDoc::open(html, opts, None).unwrap().inspect();
    assert_eq!(get(&els, "c").background_color, Some([10.0, 10.0, 18.0, 1.0])); // bg(#fff)
}

#[test]
fn a_variable_no_rule_defines_leaves_the_declaration_alone() {
    // DR's Promise never settles: the author's own `var()` stays, and resolves to nothing.
    let lines = debug_sync_css("<html><head><style>.u{background:var(--nowhere)}</style></head></html>", &indigo()).concat();
    assert!(!lines.contains(".u"), "{lines}");
}
