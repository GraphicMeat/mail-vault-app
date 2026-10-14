//! One test per parity fix (plan B, Tasks 8-9). The expected values are the
//! iframe's, copied from the harness case JSON.
use mailvault_render::inspect::InspectedElement;
use mailvault_render::{RenderDoc, RenderOptions};

fn fx(name: &str) -> String {
    std::fs::read_to_string(format!("{}/tests/fixtures/parity/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}
fn inspect(html: &str) -> Vec<InspectedElement> {
    RenderDoc::open(html, RenderOptions { css_width: 400, scale: 1.0, ..Default::default() }, None).unwrap().inspect()
}
fn get<'a>(els: &'a [InspectedElement], id: &str) -> &'a InspectedElement {
    els.iter().find(|e| e.mv_id == id).unwrap_or_else(|| panic!("no {id}"))
}

#[test]
fn bgcolor_legacy_colour_forms() {
    let els = inspect(&fx("tables-legacy.html"));
    for id in ["white", "nohash", "short"] {
        assert_eq!(get(&els, id).background_color, Some([255.0, 255.0, 255.0, 1.0]), "{id}");
    }
    assert_eq!(get(&els, "named").background_color, Some([173.0, 216.0, 230.0, 1.0]));
}

#[test]
fn font_color_attribute() {
    let els = inspect(&fx("tables-legacy.html"));
    assert_eq!(get(&els, "font").color, Some([255.0, 0.0, 0.0, 1.0]));
    assert_eq!(get(&els, "fonthex").color, Some([0.0, 255.0, 0.0, 1.0]));
}

#[test]
fn legacy_colour_attributes_follow_the_html_parsing_rules() {
    let html = r#"<body style="margin:0"><table><tr><td data-mv-id="a" bgcolor="  #0F0  ">a</td><td data-mv-id="b" bgcolor="transparent">b</td></tr></table></body>"#;
    let els = inspect(html);
    assert_eq!(get(&els, "a").background_color, Some([0.0, 255.0, 0.0, 1.0]));
    assert_eq!(get(&els, "b").background_color, Some([0.0, 0.0, 0.0, 0.0]), "transparent is not a legacy colour");
}
