//! Dark Reader inline styles and presentational attributes (Task 14), through
//! RenderDoc::open. Expected colours come from Dark Reader itself (vectors and
//! the 2026-10-11 run); SVG paint is compared against an HTML element that
//! DR maps through the same modifier.
use mailvault_render::dark::DarkTheme;
use mailvault_render::inspect::InspectedElement;
use mailvault_render::{RenderDoc, RenderOptions};

fn theme() -> DarkTheme {
    DarkTheme { bg: "#0a0a12".into(), fg: "#e8e8ef".into(), brightness: 100.0, contrast: 100.0, sepia: 0.0, top_level: false }
}
fn page(body: &str) -> String {
    format!("<!doctype html><html><head><style>body{{margin:0;background:#ffffff;color:#333333}}</style></head><body>{body}</body></html>")
}
fn open(body: &str, dark: bool) -> RenderDoc {
    let opts = RenderOptions { dark: dark.then(theme), ..RenderOptions::new(600, 1.0) };
    RenderDoc::open(&page(body), opts, None).unwrap()
}
fn dark(body: &str) -> Vec<InspectedElement> {
    open(body, true).inspect()
}
fn get<'a>(els: &'a [InspectedElement], id: &str) -> &'a InspectedElement {
    els.iter().find(|e| e.mv_id == id).unwrap_or_else(|| panic!("no {id}"))
}
const fn c(r: f64, g: f64, b: f64) -> Option<[f64; 4]> {
    Some([r, g, b, 1.0])
}
fn rgb_at(png: &[u8], x: u32, y: u32) -> [f64; 3] {
    let mut r = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
    let mut buf = vec![0; r.output_buffer_size()];
    let info = r.next_frame(&mut buf).unwrap();
    let i = ((y * info.width + x) * 3) as usize;
    [buf[i] as f64, buf[i + 1] as f64, buf[i + 2] as f64]
}
fn pixel(body: &str, dark_mode: bool, x: u32, y: u32) -> [f64; 3] {
    let mut doc = open(body, dark_mode);
    rgb_at(&doc.tile_png(0).unwrap(), x, y)
}
fn rgb3(c: Option<[f64; 4]>) -> [f64; 3] {
    let c = c.unwrap();
    [c[0], c[1], c[2]]
}

#[test]
fn inline_colour_gets_dr_override() {
    let els = dark(r#"<p data-mv-id="p" style="color:#e6375a">x</p>"#);
    assert_eq!(get(&els, "p").color, c(232.0, 71.0, 103.0)); // fg(#e6375a) = #e84767
}

#[test]
fn stripped_important_inline_colour_takes_dr_value() {
    // What stripInlineColorImportant leaves for `color:#000000 !important`.
    let els = dark(r#"<h2 data-mv-id="h" style="color:#000000; font-size:22px !important">x</h2>"#);
    assert_eq!(get(&els, "h").color, c(232.0, 232.0, 239.0)); // fg(#000) = #e8e8ef
}

#[test]
fn unstripped_important_inline_colour_beats_dr_override() {
    // Browser cascade: an inline !important outranks DR's [data-...] !important rule.
    let els = dark(r#"<h2 data-mv-id="h" style="color:#000000 !important">x</h2>"#);
    assert_eq!(get(&els, "h").color, c(0.0, 0.0, 0.0));
}

#[test]
fn bgcolor_forms_get_dr_inline_override() {
    let els = dark(
        r##"<table><tr>
        <td data-mv-id="a" bgcolor="white">a</td><td data-mv-id="b" bgcolor="ffffff">b</td>
        <td data-mv-id="c" bgcolor="#fff">c</td><td data-mv-id="d" bgcolor="#0066cc">d</td></tr></table>"##,
    );
    for id in ["a", "b", "c"] {
        assert_eq!(get(&els, id).background_color, c(10.0, 10.0, 18.0), "{id}"); // bg(#fff) = #0a0a12
    }
    assert_eq!(get(&els, "d").background_color, c(0.0, 82.0, 163.0)); // bg(#0066cc) = #0052a3
}

#[test]
fn font_color_attribute_gets_dr_override() {
    let els = dark(r##"<font data-mv-id="f" color="#e6375a">x</font>"##);
    assert_eq!(get(&els, "f").color, c(232.0, 71.0, 103.0));
}

#[test]
fn color_attribute_hex_forms_get_a_hash() {
    // L1 fix-up in overrideInlineStyle: 3/6 digits without '#', 4 digits become #hex00.
    let els = dark(r#"<font data-mv-id="a" color="e6375a">x</font><font data-mv-id="b" color="fff">y</font>"#);
    assert_eq!(get(&els, "a").color, c(232.0, 71.0, 103.0));
    assert_eq!(get(&els, "b").color, c(232.0, 232.0, 239.0)); // fg(#fff) = #e8e8ef
}

#[test]
fn inline_background_and_border_shorthands() {
    let els = dark(r#"<div data-mv-id="d" style="background:#ffffff;border:1px solid #cccccc">x</div>"#);
    assert_eq!(get(&els, "d").background_color, c(10.0, 10.0, 18.0));
    assert_eq!(get(&els, "d").border_top_color, c(47.0, 47.0, 85.0)); // border(#cccccc) = #2f2f55
}

#[test]
fn light_mode_leaves_inline_colours_alone() {
    let mut doc = open(r#"<p data-mv-id="p" style="color:#e6375a">x</p><td bgcolor="white" data-mv-id="t">y</td>"#, false);
    let els = doc.inspect();
    assert_eq!(get(&els, "p").color, c(230.0, 55.0, 90.0));
}

// ---- inline <svg> paints DR colours (Blitz serialises the svg into usvg) ----

const REF: &str = r#"<div data-mv-id="bg" style="background:#ff0000;width:1px;height:1px"></div><p data-mv-id="fg" style="color:#ff0000">x</p>"#;

fn refs() -> ([f64; 3], [f64; 3]) {
    let els = dark(REF);
    let (bg, fg) = (rgb3(get(&els, "bg").background_color), rgb3(get(&els, "fg").color));
    assert_ne!(bg, fg, "the two modifiers must tell the SVG tests apart");
    (bg, fg)
}

#[test]
fn a_large_inline_svg_shape_paints_the_dr_background_colour() {
    let (bg, _) = refs();
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#ff0000"/></svg>"##;
    assert_eq!(pixel(svg, true, 50, 50), bg);
    assert_eq!(pixel(svg, false, 50, 50), [255.0, 0.0, 0.0]);
}

#[test]
fn a_small_inline_svg_shape_paints_the_dr_foreground_colour() {
    let (_, fg) = refs();
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#ff0000"/></svg>"##;
    assert_eq!(pixel(svg, true, 12, 12), fg);
}

#[test]
fn a_small_shape_in_a_large_inline_svg_paints_the_foreground_colour() {
    // DR measures the element's own box: 10 x 10 is not over 32.
    let (_, fg) = refs();
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect x="40" y="40" width="10" height="10" fill="#ff0000"/></svg>"##;
    assert_eq!(pixel(svg, true, 45, 45), fg);
}

#[test]
fn an_inline_svg_gradient_stop_paints_the_dr_background_colour() {
    let (bg, _) = refs();
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#ff0000"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/></svg>"##;
    assert_eq!(pixel(svg, true, 50, 50), bg);
}

#[test]
fn an_inline_svg_stroke_paints_the_dr_foreground_colour() {
    let (_, fg) = refs();
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect x="10" y="10" width="80" height="80" fill="none" stroke="#ff0000" stroke-width="20"/></svg>"##;
    assert_eq!(pixel(svg, true, 10, 50), fg);
}

#[test]
fn a_logo_svg_is_left_alone() {
    // DR hands these to its raster analysis (a known diff); it never recolours them.
    let svg = r##"<svg class="site-logo" xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#ff0000"/></svg>"##;
    assert_eq!(pixel(svg, true, 50, 50), [255.0, 0.0, 0.0]);
}

#[test]
fn the_svg_measuring_layout_pass_still_queues_css_images() {
    // The early layout pass runs inside the net provider's layout window, so a
    // CSS image found by it is queued once (not denied as a held request).
    let net = mailvault_render::net::BridgeNet::new(true);
    let body = r##"<div style="background-image:url(https://i.test/bg.png);width:50px;height:50px"></div><svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#ff0000"/></svg>"##;
    let opts = RenderOptions { dark: Some(theme()), ..RenderOptions::new(600, 1.0) };
    let _doc = RenderDoc::open(&page(body), opts, Some(net.clone())).unwrap();
    let urls: Vec<String> = net.take_outbox().into_iter().map(|r| r.url).collect();
    assert_eq!(urls, vec!["https://i.test/bg.png".to_string()]);
}
