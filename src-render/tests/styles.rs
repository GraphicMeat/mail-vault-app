use mailvault_render::inspect::InspectedElement;
use mailvault_render::{RenderDoc, RenderOptions};

fn inspect(html: &str) -> Vec<InspectedElement> {
    RenderDoc::open(html, RenderOptions { css_width: 400, scale: 1.0, ..Default::default() }, None).unwrap().inspect()
}
fn get<'a>(els: &'a [InspectedElement], id: &str) -> &'a InspectedElement {
    els.iter().find(|e| e.mv_id == id).unwrap()
}

#[test]
fn style_media_attribute_is_honoured() {
    let els = inspect(r#"<!doctype html><html><head><style>p{color:#222222;background:#ffffff}</style></head><body>
<style media="(mv-suppressed-color-scheme: dark)">p{color:#f5f5f5;background:#171717}</style>
<style media="print">.p2{color:#ff0000}</style>
<p data-mv-id="p">x</p><p class="p2" data-mv-id="p2">y</p></body></html>"#);
    assert_eq!(get(&els, "p").color, Some([34.0, 34.0, 34.0, 1.0]));
    assert_eq!(get(&els, "p").background_color, Some([255.0, 255.0, 255.0, 1.0]));
    assert_eq!(get(&els, "p2").color, Some([34.0, 34.0, 34.0, 1.0]));
}

#[test]
fn screen_media_and_plain_styles_still_apply_in_order() {
    let els = inspect(r#"<style>p{color:#ff0000}</style><style media="screen">p{color:#00ff00}</style><style>p.b{color:#0000ff}</style>
<p data-mv-id="a">a</p><p class="b" data-mv-id="b">b</p>"#);
    assert_eq!(get(&els, "a").color, Some([0.0, 255.0, 0.0, 1.0]));
    assert_eq!(get(&els, "b").color, Some([0.0, 0.0, 255.0, 1.0]));
}

fn colour(html: &str, id: &str) -> Option<[f64; 4]> {
    get(&inspect(html), id).color
}

#[test]
fn a_rewritten_sheet_decodes_entities_like_an_untouched_one() {
    // blitz-dom decodes HTML entities in <style> text when it parses a sheet. A sheet that is
    // rewritten (here for its media attribute; in dark mode, every sheet) must not be decoded
    // one more time. The rule matches `a` after one decode, `b` after two, `c` after none.
    let rule = r#"p[title="&amp;lt;"]{color:#ff0000}"#;
    let ps = r#"<p data-mv-id="a" title="&amp;lt;">a</p><p data-mv-id="b" title="&lt;">b</p><p data-mv-id="c" title="&amp;amp;lt;">c</p>"#;
    let colours = |html: &str| {
        let els = inspect(html);
        ["a", "b", "c"].map(|id| get(&els, id).color)
    };
    let plain = colours(&format!("<style>{rule}</style>{ps}"));
    let rewritten = colours(&format!(r#"<style media="screen">{rule}</style>{ps}"#));
    eprintln!("plain {plain:?}, rewritten {rewritten:?}");
    assert_eq!(plain.iter().filter(|c| **c == Some([255.0, 0.0, 0.0, 1.0])).count(), 1, "the rule matches one of them");
    assert_eq!(rewritten, plain);
}

#[test]
fn a_media_attribute_is_parsed_as_a_media_list_not_pasted_into_css() {
    // A browser reads `screen /*` as `screen` (the comment runs to the end of the value).
    assert_eq!(colour(r#"<style media="screen /*">p{color:#ff0000}</style><p data-mv-id="p">x</p>"#, "p"), Some([255.0, 0.0, 0.0, 1.0]));
    // Braces cannot close the wrapper and add rules: an invalid list is `not all`.
    let breakout = r#"<style media="print{} p{color:#00ff00}">p{color:#ff0000}</style><p data-mv-id="p">x</p>"#;
    assert_eq!(colour(breakout, "p"), Some([0.0, 0.0, 0.0, 1.0]));
}
