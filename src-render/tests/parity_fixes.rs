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
fn inspect_at(html: &str, css_width: u32) -> Vec<InspectedElement> {
    RenderDoc::open(html, RenderOptions { css_width, scale: 1.0, ..Default::default() }, None).unwrap().inspect()
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
fn cellpadding_pads_the_cells_of_its_table() {
    let els = inspect(&fx("tables-legacy.html"));
    let r = get(&els, "padded").rect.clone().unwrap();
    assert_eq!((r.x, r.w), (0.0, 70.0), "50px content + 2 x 10px padding, no spacing");
}

#[test]
fn cellspacing_sets_border_spacing() {
    let els = inspect(&fx("tables-legacy.html"));
    assert_eq!(get(&els, "spaced").rect.clone().unwrap().x, 8.0);
}

#[test]
fn valign_sets_vertical_align() {
    let els = inspect(&fx("tables-legacy.html"));
    let top = get(&els, "top").rect.clone().unwrap().y;
    let bottom = get(&els, "bottom").rect.clone().unwrap().y;
    assert!(bottom - top > 50.0, "top {top} bottom {bottom}");
}

#[test]
fn table_align_center_centres_the_table() {
    let els = inspect(&fx("tables-legacy.html"));
    assert_eq!(get(&els, "centred").rect.clone().unwrap().x, 100.0);
}

#[test]
fn cellpadding_is_per_table_and_never_shared_between_look_alike_cells() {
    let html = r#"<body style="margin:0"><table cellspacing="0" cellpadding="10"><tr><td data-mv-id="a" style="width:50px">x</td></tr></table>
<table cellspacing="0" cellpadding="0"><tr><td data-mv-id="b" style="width:50px">x</td></tr></table>
<table cellspacing="0"><tr><td data-mv-id="c" style="width:50px">x</td></tr></table></body>"#;
    let els = inspect(html);
    assert_eq!(get(&els, "a").rect.clone().unwrap().w, 70.0);
    assert_eq!(get(&els, "b").rect.clone().unwrap().w, 50.0);
    assert_eq!(get(&els, "c").rect.clone().unwrap().w, 52.0, "no cellpadding keeps the UA 1px");
}

#[test]
fn legacy_colour_attributes_follow_the_html_parsing_rules() {
    let html = r#"<body style="margin:0"><table><tr><td data-mv-id="a" bgcolor="  #0F0  ">a</td><td data-mv-id="b" bgcolor="transparent">b</td></tr></table></body>"#;
    let els = inspect(html);
    assert_eq!(get(&els, "a").background_color, Some([0.0, 255.0, 0.0, 1.0]));
    assert_eq!(get(&els, "b").background_color, Some([0.0, 0.0, 0.0, 0.0]), "transparent is not a legacy colour");
}

#[test]
fn table_border_attribute_defaults_to_one_px_when_present_but_not_a_number() {
    let html = r#"<body style="margin:0"><table data-mv-id="empty" border><tr><td data-mv-id="ec">x</td></tr></table>
<table data-mv-id="junk" border="thick"><tr><td>x</td></tr></table></body>"#;
    let els = inspect(html);
    for id in ["empty", "junk"] {
        let t = get(&els, id);
        assert_eq!((t.border_top_width, t.border_left_width), (Some(1.0), Some(1.0)), "{id}");
    }
    assert_eq!(get(&els, "ec").border_top_width, Some(1.0));
}

#[test]
fn table_bordercolor_colours_the_table_and_is_inherited_by_its_cells() {
    let html = r##"<body style="margin:0"><table data-mv-id="t" border="2" bordercolor="#336699"><tr><td data-mv-id="c">x</td></tr></table></body>"##;
    let els = inspect(html);
    assert_eq!(get(&els, "t").border_top_color, Some([51.0, 102.0, 153.0, 1.0]));
    assert_eq!(get(&els, "c").border_left_color, Some([51.0, 102.0, 153.0, 1.0]));
}

const TALL_ROW: &str = r#"<body style="margin:0;font:14px/20px sans-serif"><table cellspacing="0" cellpadding="0"><tr>
<td data-mv-id="tall"><div style="width:20px;height:100px"></div></td>
<td data-mv-id="cell" VALIGN><div data-mv-id="blk" style="width:20px;height:10px"></div></td>
<td data-mv-id="txt" VALIGN><span data-mv-id="span">t</span></td>
</tr></table></body>"#;

fn tall_row(valign: &str) -> Vec<InspectedElement> {
    let attr = if valign.is_empty() { String::new() } else { format!("valign=\"{valign}\"") };
    inspect(&TALL_ROW.replace("VALIGN", &attr))
}

#[test]
fn block_cell_content_follows_valign_inside_a_full_height_cell() {
    for (valign, dy) in [("top", 0.0), ("", 45.0), ("middle", 45.0), ("bottom", 90.0)] {
        let els = tall_row(valign);
        let cell = get(&els, "cell").rect.clone().unwrap();
        let blk = get(&els, "blk").rect.clone().unwrap();
        assert_eq!(cell.h, 100.0, "the cell keeps the row height ({valign:?})");
        assert!((blk.y - cell.y - dy).abs() < 0.5, "{valign:?}: block at {} in a cell at {}", blk.y, cell.y);
    }
}

#[test]
fn text_cell_content_follows_valign_and_the_cell_box_does_not_move() {
    let top = tall_row("top");
    let top_dy = get(&top, "span").rect.clone().unwrap().y - get(&top, "txt").rect.clone().unwrap().y;
    for (valign, share) in [("", 0.5), ("middle", 0.5), ("bottom", 1.0)] {
        let els = tall_row(valign);
        let cell = get(&els, "txt").rect.clone().unwrap();
        let span = get(&els, "span").rect.clone().unwrap();
        assert_eq!((cell.y, cell.h), (0.0, 100.0), "{valign:?}");
        let moved = span.y - cell.y - top_dy;
        assert!((moved - 80.0 * share).abs() < 0.5, "{valign:?}: text moved {moved}");
    }
}

/// WebKit sets the optical-size axis of the macOS system font to the CSS font
/// size (`font-optical-sizing: auto`, clamped to the axis, 17 at 14px). The
/// variable SFNS.ttf defaults to opsz 28, the display cut, which is ~11%
/// narrower at body sizes. Widths from the harness iframe (WebKit, light, wide).
#[cfg(target_os = "macos")]
#[test]
fn system_font_uses_the_optical_size_for_its_font_size() {
    let els = inspect(&fx("system-font-optical-size.html"));
    let w = get(&els, "read").rect.clone().unwrap().w;
    assert!((w - 69.43).abs() <= 1.0, "-apple-system 14px 'Read more': {w}, iframe 69.43");
}

/// WebKit truncates a computed line-height to whole px (RenderStyle::computedLineHeight
/// returns int), so `line-height: 1.6` is 22px at 14px, not 22.4. Blitz kept the
/// fraction, which added up to 0.4px per line down a message. Heights from the
/// harness iframe (basic-typography, light, wide): p 3 lines 66, h2 33, h1 44.
#[test]
fn line_height_is_truncated_to_whole_pixels() {
    let els = inspect(&fx("line-height-truncation.html"));
    let h = |id: &str| get(&els, id).rect.clone().unwrap().h;
    assert_eq!((h("p14"), h("h21"), h("h28")), (66.0, 33.0, 44.0));
    assert_eq!(h("p13"), 42.0, "1.625 x 13px = 21.125 -> 21 per line");
}

/// The HTML rendering UA sheet gives thead, tbody, tfoot and tr `border-color: inherit`,
/// so a row group carries its table's colour (the harness iframe: postmark invoice,
/// table `border: 1px solid #EAEAEC` -> tbody and tr rgb(234,234,236)). A cell keeps
/// currentcolor.
#[test]
fn row_groups_and_rows_inherit_the_border_colour_of_their_table() {
    let els = inspect(&fx("table-border-colour-inherit.html"));
    for id in ["t", "th", "thr", "tb", "tr", "tf"] {
        assert_eq!(get(&els, id).border_top_color, Some([234.0, 234.0, 236.0, 1.0]), "{id}");
    }
    assert_eq!(get(&els, "td").border_top_color, Some([81.0, 84.0, 94.0, 1.0]), "a cell keeps currentcolor");
}

/// In the collapsing border model a cell with `border-style: none` has a used width of 0,
/// but its computed `border-width` is still `medium` (3px). Blitz took the computed width,
/// so every cerberus table (`border-collapse: collapse`, no borders) sat 3px inside its
/// own box. The harness iframe has the table's tbody, row and cells at (0, 0).
#[test]
fn collapsed_borders_of_a_borderless_cell_are_zero() {
    let els = inspect(&fx("table-collapse-no-border.html"));
    let t = get(&els, "t").rect.clone().unwrap();
    let c = get(&els, "c").rect.clone().unwrap();
    assert_eq!((c.x, c.y, c.w), (0.0, 0.0, 400.0), "cell");
    assert_eq!(t.h, c.h, "no collapsed border adds to the table height");
}

/// A `display:block` child of a table row sits in an anonymous table cell together with
/// its consecutive non-cell siblings (CSS 2 17.2.1), so the children stack inside one
/// cell. cerberus stacks its `<th class="stack-column-center">` columns this way under
/// `@media (max-width: 600px)`; Blitz dropped such a child with its whole subtree (the
/// harness iframe, responsive-inbody: table 556x292, th[1] 556x146, th[2] below it at
/// the same x; Blitz 0x0). The second table drives the same markup from the @media rule.
#[test]
fn block_children_of_a_table_row_share_one_anonymous_cell() {
    let els = inspect(&fx("table-row-block-children.html"));
    let r = |id: &str| {
        let r = get(&els, id).rect.clone().unwrap();
        (r.x, r.y, r.w, r.h)
    };
    assert_eq!(r("a1"), (0.0, 0.0, 400.0, 30.0));
    assert_eq!(r("a2"), (0.0, 30.0, 400.0, 40.0));
    assert_eq!(r("ta"), (0.0, 0.0, 400.0, 70.0));
    assert_eq!(r("b1"), (0.0, 70.0, 400.0, 30.0), "the @media rule applies at a 400px viewport");
    assert_eq!(r("b2"), (0.0, 100.0, 400.0, 40.0));
    assert_eq!(r("tb"), (0.0, 70.0, 400.0, 70.0));
}

/// A table clamped to its pane (the base sheet's `table { max-width: 100%; width: auto }`)
/// shrinks its fixed-width columns: an auto-layout column is at least its content's
/// minimum and at most its specified width, and the table's width is shared out between
/// them. Blitz kept every `width="200"` column at 200 and let the row overflow the table
/// (tbody and tr 600 in a 528 table). Widths from the harness iframe (ours/table-600-narrow,
/// light, wide: pane 576, body padding 24).
#[test]
fn fixed_width_columns_shrink_to_a_clamped_table() {
    let els = inspect_at(&fx("table-clamped-columns.html"), 576);
    let w = |id: &str| get(&els, id).rect.clone().unwrap().w;
    // (id, iframe width). The row of a table is the union of its cells.
    let want = [
        ("t1", 528.0),
        ("r1", 528.0),
        ("c1", 176.95),
        ("c2", 175.53),
        ("c3", 175.53),
        // One fixed 600px cell between two cells holding a nbsp.
        ("t2", 528.0),
        ("r2", 528.0),
        ("d1", 3.89),
        ("d2", 520.22),
        ("d3", 3.89),
    ];
    let off: Vec<String> = want
        .iter()
        .filter(|(id, iframe)| (w(id) - iframe).abs() > 1.0)
        .map(|(id, iframe)| format!("{id}: {:.2}, iframe {iframe}", w(id)))
        .collect();
    assert!(off.is_empty(), "widths off by more than 1px: {off:?}");
}

/// parley trims a span's text with Unicode White_Space (a no-break space goes) and takes a
/// trailing nbsp's advance off the content widths. Only collapsible space does either, so a
/// `<td>&nbsp;</td>` spacer is a space wide: 3.89 px at 14px Arial in the harness iframe
/// (ours/table-600-narrow, leemunroe spacer cells), 0 in Blitz. A leading or trailing nbsp
/// keeps its advance in running text too.
#[test]
fn a_no_break_space_at_the_edge_of_a_text_run_keeps_its_width() {
    let els = inspect(&fx("nbsp-at-text-edges.html"));
    let w = |id: &str| get(&els, id).rect.clone().unwrap().w;
    assert!((w("spacer") - 3.89).abs() <= 1.0, "spacer cell: {}, iframe 3.89", w("spacer"));
    let nbsp = w("spacer");
    assert!((w("indented") - w("plain") - 2.0 * nbsp).abs() <= 1.0, "two leading nbsp: {} vs {}", w("indented"), w("plain"));
    assert!((w("trailing") - w("plain") - nbsp).abs() <= 1.0, "trailing nbsp: {} vs {}", w("trailing"), w("plain"));
}

/// A line box always holds the strut of its block's font and line-height, so a cell with
/// one inline `<img>` is the image plus the part of the strut below the baseline: at
/// `line-height` 22px that is 6px (harness iframe, cerberus header cell: padding 20px, an
/// image 50px tall, cell 96px; Blitz 90 and every y below it 6px short). A block image has
/// no line box.
#[test]
fn a_line_with_only_an_image_keeps_the_strut_below_the_baseline() {
    let els = inspect(&fx("line-with-only-an-image.html"));
    let r = |id: &str| get(&els, id).rect.clone().unwrap();
    assert!((r("inline").h - 96.0).abs() <= 1.0, "cell with an inline image: {}, iframe 96", r("inline").h);
    assert_eq!(r("logo").y - r("inline").y, 20.0, "the image sits at the top of the line");
    assert_eq!(r("block").h, 90.0, "a block image has no strut");
    assert_eq!(r("block").y, r("inline").y + r("inline").h);
}

/// CSS 2 17.5.3: a row is as high as the largest of its own `height`, the `height` of
/// each of its cells and the room their content needs, and every cell fills the row.
/// Blitz left the `tr` height out and started a cell with a `height` of its own at the row
/// top at that height, so a coloured cell stopped short of the row.
#[test]
fn rows_honour_their_height_and_cells_fill_the_row() {
    let els = inspect(&fx("table-row-and-cell-heights.html"));
    let h = |id: &str| get(&els, id).rect.clone().unwrap().h;
    assert_eq!((h("a"), h("b")), (60.0, 60.0), "row 1 takes the tr height, both cells fill it");
    assert_eq!((h("c"), h("d")), (80.0, 80.0), "row 2 takes the tallest cell, the shorter one fills it");
    assert_eq!(h("r1"), 60.0);
    assert_eq!(h("r2"), 80.0);
}
