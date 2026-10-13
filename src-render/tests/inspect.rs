use mailvault_render::inspect::{cluster_line_count, InspectedElement};
use mailvault_render::{RenderDoc, RenderOptions};

const HTML: &str = r#"<!doctype html><html><body style="margin:0;font:16px/20px sans-serif;color:#102030">
<div data-mv-id="box" style="width:200px;height:50px;background:#ff0000;border:2px solid #00ff00;border-left-color:rgba(0,0,255,0.5)"></div>
<p data-mv-id="para" style="margin:0;width:60px">one two three four five six</p>
<span data-mv-id="span" style="font-weight:700;font-size:13px">x</span>
<div style="display:none"><b data-mv-id="hidden">gone</b></div>
<div data-mv-id="far" style="margin-top:1200px;height:10px"></div>
</body></html>"#;

fn open() -> RenderDoc {
    RenderDoc::open(HTML, RenderOptions { css_width: 600, scale: 1.0, ..Default::default() }, None).unwrap()
}
fn by_id<'a>(els: &'a [InspectedElement], id: &str) -> &'a InspectedElement {
    els.iter().find(|e| e.mv_id == id).unwrap_or_else(|| panic!("no {id}"))
}

#[test]
fn reports_every_marked_element_in_tree_order() {
    let els = open().inspect();
    let ids: Vec<_> = els.iter().map(|e| e.mv_id.as_str()).collect();
    assert_eq!(ids, ["box", "para", "span", "hidden", "far"]);
}

#[test]
fn colours_are_resolved_srgb_bytes_with_alpha() {
    let els = open().inspect();
    let b = by_id(&els, "box");
    assert_eq!(b.color, Some([16.0, 32.0, 48.0, 1.0]), "inherited from body");
    assert_eq!(b.background_color, Some([255.0, 0.0, 0.0, 1.0]));
    assert_eq!(b.border_top_color, Some([0.0, 255.0, 0.0, 1.0]));
    assert_eq!(b.border_left_color, Some([0.0, 0.0, 255.0, 0.5]));
}

#[test]
fn rect_is_the_border_box_in_document_px() {
    let els = open().inspect();
    let r = by_id(&els, "box").rect.clone().unwrap();
    assert_eq!((r.x, r.y, r.w, r.h), (0.0, 0.0, 204.0, 54.0));
}

#[test]
fn font_size_and_weight_are_computed_numbers() {
    let els = open().inspect();
    let s = by_id(&els, "span");
    assert_eq!(s.font_size, Some(13.0));
    assert_eq!(s.font_weight, Some(700.0));
    assert!(s.font_family.as_deref().unwrap_or("").contains("sans-serif"));
}

#[test]
fn narrow_paragraph_wraps_to_several_lines() {
    let els = open().inspect();
    assert!(by_id(&els, "para").line_count.unwrap() > 1);
    assert_eq!(by_id(&els, "box").line_count, None, "no text, no count");
}

#[test]
fn display_none_subtree_is_not_rendered() {
    let els = open().inspect();
    let h = by_id(&els, "hidden");
    assert!(!h.rendered);
    assert!(h.rect.is_none());
    assert_eq!(h.line_count, None);
}

#[test]
fn rects_ignore_tile_scroll() {
    let mut doc = open();
    let before = by_id(&doc.inspect(), "far").rect.clone().unwrap().y;
    let _ = doc.tile_png(2); // moves the viewport scroll to y = 1024
    let after = by_id(&doc.inspect(), "far").rect.clone().unwrap().y;
    assert!(before >= 1200.0);
    assert_eq!(before, after);
}

#[test]
fn clustering_merges_spans_whose_midpoint_overlaps() {
    assert_eq!(cluster_line_count(vec![(0.0, 20.0), (2.0, 18.0), (20.0, 40.0), (41.0, 60.0)]), 3);
    assert_eq!(cluster_line_count(vec![]), 0);
}

#[test]
fn inline_rect_is_the_font_content_area_not_the_line_box() {
    let html = r#"<body style="margin:0"><p style="margin:0;font:20px/60px sans-serif"><span data-mv-id="s">Hg</span></p>
<p style="margin:0"><a data-mv-id="empty" name="x"></a>t</p></body>"#;
    let els = RenderDoc::open(html, RenderOptions { css_width: 400, scale: 1.0, ..Default::default() }, None).unwrap().inspect();
    let s = by_id(&els, "s").rect.clone().unwrap();
    assert!(s.h > 15.0 && s.h < 35.0, "content area, not the 60px line box: h {}", s.h);
    assert!(s.y > 10.0, "sits inside the 60px line: y {}", s.y);
    let empty = by_id(&els, "empty");
    assert!(empty.rect.as_ref().map_or(true, |r| r.w == 0.0), "{:?}", empty.rect);
}
