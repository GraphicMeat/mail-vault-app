//! Dark mode through RenderDoc::open, measured with inspect. The expected
//! values come from Dark Reader itself (vectors and the 2026-10-11 run).
use mailvault_render::dark::DarkTheme;
use mailvault_render::inspect::InspectedElement;
use mailvault_render::{RenderDoc, RenderOptions};

const BASE: &str = "<style>html, body { margin: 0; padding: 0; background: #ffffff; color: #333333; }</style>";

fn theme() -> DarkTheme {
    DarkTheme { bg: "#0a0a12".into(), fg: "#e8e8ef".into(), brightness: 100.0, contrast: 100.0, sepia: 0.0, top_level: false }
}
fn open(width: u32, html: &str) -> Vec<InspectedElement> {
    let opts = RenderOptions { dark: Some(theme()), ..RenderOptions::new(width, 1.0) };
    RenderDoc::open(html, opts, None).unwrap().inspect()
}
fn dark(width: u32, body: &str) -> Vec<InspectedElement> {
    open(width, &format!("<!doctype html><html><head>{BASE}</head><body data-mv-id=\"body\">{body}</body></html>"))
}
fn get<'a>(els: &'a [InspectedElement], id: &str) -> &'a InspectedElement {
    els.iter().find(|e| e.mv_id == id).unwrap_or_else(|| panic!("no {id}"))
}
const fn c(r: f64, g: f64, b: f64) -> Option<[f64; 4]> {
    Some([r, g, b, 1.0])
}

#[test]
fn body_and_base_sheet_take_dr_colours() {
    let els = dark(600, "<p data-mv-id=\"p\">x</p>");
    assert_eq!(get(&els, "body").background_color, c(10.0, 10.0, 18.0)); // bg(#fff) = #0a0a12
    assert_eq!(get(&els, "p").color, c(187.0, 187.0, 208.0)); // fg(#333333) = #bbbbd0
}

#[test]
fn ua_sheet_colours_links_and_tables() {
    let els = dark(600, "<a data-mv-id=\"a\" href=\"https://x.test\">l</a><table data-mv-id=\"t\" border=\"1\"><tr><td>x</td></tr></table>");
    assert_eq!(get(&els, "a").color, c(51.0, 145.0, 255.0)); // fg(0,64,255) = #3391ff
    assert_eq!(get(&els, "t").border_top_color, c(64.0, 64.0, 115.0)); // border(128,128,128) = #404073
}

#[test]
fn already_dark_email_keeps_dr_mapping() {
    let els = dark(
        600,
        "<style>.wrap{background:#171717;color:#ffffff}.card{background:#1a1a1a}</style>\
        <div class=\"wrap\" data-mv-id=\"wrap\"><div class=\"card\" data-mv-id=\"card\">t</div></div>",
    );
    assert_eq!(get(&els, "wrap").background_color, c(13.0, 13.0, 24.0)); // bg(#171717) = #0d0d18
    assert_eq!(get(&els, "wrap").color, c(232.0, 232.0, 239.0)); // fg(#ffffff) = #e8e8ef
    assert_eq!(get(&els, "card").background_color, c(15.0, 15.0, 27.0)); // bg(#1a1a1a) = #0f0f1b
}

#[test]
fn specificity_and_order_survive_the_sync_rules() {
    let els = dark(
        600,
        "<style>.x{color:#e6375a}</style><style>p.x{color:#0066cc}</style><p class=\"x\" data-mv-id=\"p\">x</p><span class=\"x\" data-mv-id=\"s\">y</span>",
    );
    assert_eq!(get(&els, "p").color, c(84.0, 178.0, 255.0)); // fg(#0066cc) = #54b2ff
    assert_eq!(get(&els, "s").color, c(232.0, 71.0, 103.0)); // fg(#e6375a) = #e84767
}

#[test]
fn media_groups_follow_the_viewport() {
    let css = "<style>@media (max-width: 480px){ .m{color:#0066cc} }</style><p class=\"m\" data-mv-id=\"m\">x</p>";
    assert_eq!(get(&dark(375, css), "m").color, c(84.0, 178.0, 255.0));
    assert_eq!(get(&dark(600, css), "m").color, c(187.0, 187.0, 208.0));
}

#[test]
fn print_media_gets_no_sync_rules() {
    let els = dark(600, "<style>@media print { .p{color:#0066cc} }</style><p class=\"p\" data-mv-id=\"p\">x</p>");
    assert_eq!(get(&els, "p").color, c(187.0, 187.0, 208.0));
}

#[test]
fn a_print_style_element_is_not_managed() {
    // DR's shouldManageStyle skips <style media="print">: no sync rules, and
    // Task 8's @media wrap keeps the author rules off the screen.
    let els = dark(600, "<style media=\"print\">.p{color:#0066cc}</style><p class=\"p\" data-mv-id=\"p\">x</p>");
    assert_eq!(get(&els, "p").color, c(187.0, 187.0, 208.0));
}

#[test]
fn a_document_without_any_style_still_gets_the_static_sheets() {
    let els = open(600, "<html><body data-mv-id=\"body\"><a data-mv-id=\"a\" href=\"https://x.test\">l</a></body></html>");
    assert_eq!(get(&els, "a").color, c(51.0, 145.0, 255.0));
}

#[test]
fn light_mode_is_untouched() {
    let html = format!("<!doctype html><html><head>{BASE}</head><body data-mv-id=\"body\"><p data-mv-id=\"p\">x</p></body></html>");
    let els = RenderDoc::open(&html, RenderOptions::new(600, 1.0), None).unwrap().inspect();
    assert_eq!(get(&els, "body").background_color, c(255.0, 255.0, 255.0));
    assert_eq!(get(&els, "p").color, c(51.0, 51.0, 51.0));
}
