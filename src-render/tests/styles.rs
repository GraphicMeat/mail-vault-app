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
