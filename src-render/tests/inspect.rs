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

fn union(rs: &[mailvault_render::inspect::InspectRect]) -> (f64, f64, f64, f64) {
    let x0 = rs.iter().map(|r| r.x).fold(f64::MAX, f64::min);
    let y0 = rs.iter().map(|r| r.y).fold(f64::MAX, f64::min);
    let x1 = rs.iter().map(|r| r.x + r.w).fold(f64::MIN, f64::max);
    let y1 = rs.iter().map(|r| r.y + r.h).fold(f64::MIN, f64::max);
    (x0, y0, x1 - x0, y1 - y0)
}

#[test]
fn table_rows_and_row_groups_report_the_union_of_their_cells() {
    // Blitz gives a row or row group no box of its own (0x0 at the origin);
    // WebKit's getBoundingClientRect reports the cells' extent.
    let html = r#"<body style="margin:0;font:16px/20px sans-serif"><table data-mv-id="t" style="width:300px;border-collapse:separate;border-spacing:0">
<thead data-mv-id="thead"><tr data-mv-id="hr"><th data-mv-id="h1">head</th></tr></thead>
<tbody data-mv-id="tb"><tr data-mv-id="r1"><td data-mv-id="a" style="width:100px;padding:4px">a</td><td data-mv-id="b" style="padding:4px">b<br>b</td></tr>
<tr data-mv-id="r2"><td data-mv-id="c" style="padding:4px">c</td><td data-mv-id="d" style="padding:4px">d</td></tr></tbody>
<tfoot data-mv-id="tf"><tr data-mv-id="fr"><td data-mv-id="f1">foot</td></tr></tfoot></table></body>"#;
    let els = RenderDoc::open(html, RenderOptions { css_width: 600, scale: 1.0, ..Default::default() }, None).unwrap().inspect();
    let rect = |id: &str| by_id(&els, id).rect.clone().unwrap_or_else(|| panic!("{id} has no rect"));
    let near = |a: (f64, f64, f64, f64), b: (f64, f64, f64, f64), what: &str| {
        assert!((a.0 - b.0).abs() < 0.01 && (a.1 - b.1).abs() < 0.01 && (a.2 - b.2).abs() < 0.01 && (a.3 - b.3).abs() < 0.01, "{what}: {a:?} vs {b:?}");
    };
    let r1 = union(&[rect("a"), rect("b")]);
    assert!(r1.2 > 0.0 && r1.3 > 0.0, "cells have a size: {r1:?}");
    let r1_got = rect("r1");
    near((r1_got.x, r1_got.y, r1_got.w, r1_got.h), r1, "tr = union of its tds");
    let r2 = union(&[rect("c"), rect("d")]);
    let r2_got = rect("r2");
    near((r2_got.x, r2_got.y, r2_got.w, r2_got.h), r2, "second tr");
    let rows = union(&[rect("r1"), rect("r2")]);
    let tb = rect("tb");
    near((tb.x, tb.y, tb.w, tb.h), rows, "tbody = union of its trs");
    let th = rect("thead");
    let hr = rect("hr");
    near((th.x, th.y, th.w, th.h), (hr.x, hr.y, hr.w, hr.h), "thead = its only tr");
    let tf = rect("tf");
    let fr = rect("fr");
    near((tf.x, tf.y, tf.w, tf.h), (fr.x, fr.y, fr.w, fr.h), "tfoot = its only tr");
    assert!(tb.y > th.y, "body below head");
}

#[test]
fn inline_after_a_block_sibling_reports_its_lines() {
    // `<a>` follows a block sibling, so it sits in an anonymous inline root that
    // is not a DOM descendant of its parent. The same holds for the text the
    // parent holds after the block.
    let html = r##"<body style="margin:0;font:16px/20px sans-serif"><div data-mv-id="d"><p style="margin:0">first</p><a data-mv-id="a" href="#">link</a> tail</div>
<div data-mv-id="e"><p style="margin:0">first</p>loose <b data-mv-id="b">bold</b></div></body>"##;
    let els = RenderDoc::open(html, RenderOptions { css_width: 400, scale: 1.0, ..Default::default() }, None).unwrap().inspect();
    assert_eq!(by_id(&els, "a").line_count, Some(1), "anonymous inline");
    assert_eq!(by_id(&els, "b").line_count, Some(1), "inline after loose text");
    assert_eq!(by_id(&els, "d").line_count, Some(2), "block parent: its p line plus the anonymous line");
    assert_eq!(by_id(&els, "e").line_count, Some(2));
}

#[test]
fn border_widths_are_used_px_per_side() {
    let html = r#"<body style="margin:0"><div data-mv-id="b" style="border:2px solid #0f0;border-left-width:5px;border-bottom:0 none"></div>
<div data-mv-id="none" style="border:3px none #000"></div><div data-mv-id="plain"></div></body>"#;
    let els = RenderDoc::open(html, RenderOptions { css_width: 300, scale: 1.0, ..Default::default() }, None).unwrap().inspect();
    let b = by_id(&els, "b");
    assert_eq!((b.border_top_width, b.border_right_width, b.border_bottom_width, b.border_left_width), (Some(2.0), Some(2.0), Some(0.0), Some(5.0)));
    let none = by_id(&els, "none");
    assert_eq!((none.border_top_width, none.border_left_width), (Some(0.0), Some(0.0)), "border-style none computes to 0");
    assert_eq!(by_id(&els, "plain").border_top_width, Some(0.0));
    let json = serde_json::to_value(b).unwrap();
    assert_eq!(json["borderTopWidth"], 2.0);
    assert_eq!(json["borderLeftWidth"], 5.0);
}

#[test]
fn table_border_attribute_gives_the_table_a_border() {
    // HTML rendering section: table[border=N] draws an N px table border, and
    // every td/th of a table with a non-zero border gets a 1px inset border.
    let html = r#"<body style="margin:0"><table data-mv-id="t" border="3"><tr><th data-mv-id="h">x</th><td data-mv-id="c">x</td></tr></table>
<table data-mv-id="zero" border="0"><tr><td data-mv-id="zc">x</td></tr></table></body>"#;
    let els = RenderDoc::open(html, RenderOptions { css_width: 300, scale: 1.0, ..Default::default() }, None).unwrap().inspect();
    let t = by_id(&els, "t");
    assert_eq!((t.border_top_width, t.border_right_width, t.border_bottom_width, t.border_left_width), (Some(3.0), Some(3.0), Some(3.0), Some(3.0)), "table border attribute");
    for id in ["h", "c"] {
        let cell = by_id(&els, id);
        assert_eq!((cell.border_top_width, cell.border_right_width, cell.border_bottom_width, cell.border_left_width), (Some(1.0), Some(1.0), Some(1.0), Some(1.0)), "cell {id}");
    }
    let zero = by_id(&els, "zero");
    assert_eq!((zero.border_top_width, zero.border_left_width), (Some(0.0), Some(0.0)), "border=0 draws nothing");
    assert_eq!(by_id(&els, "zc").border_top_width, Some(0.0), "cells of a border=0 table stay unbordered");
}
