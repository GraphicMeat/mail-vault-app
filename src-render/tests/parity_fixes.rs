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
    assert_eq!(r("logo").h, 50.0, "the strut is not part of the image's box");
    assert_eq!(r("block").h, 90.0, "a block image has no strut");
    assert_eq!(r("block").y, r("inline").y + r("inline").h);
    // An inline-block button is not on the strut's baseline: it already reaches below it
    // (gradients-shadows: padding 24 + button 42 + 24 = 90 in the iframe).
    assert_eq!(r("button").h, 20.0 + 22.0 + 20.0 + 20.0, "no strut under an inline-block");
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

/// WebKit reports a row (and a row group) of a table with the default `border-spacing: 2px`
/// across the table's whole content box, spacing included, and a row group also covers the
/// spacing above its first and below its last row. Harness iframe (postmark password-reset,
/// `table` with border-top 1px and padding-top 25px at (69, 577.7) 438 wide): tbody
/// (69, 603.7, 438, 105.06), tr (69, 605.7, 438, 101.06), td (71, 605.7, 434, 101.06).
#[test]
fn rows_span_the_table_content_box_under_border_spacing() {
    let els = inspect(&fx("table-border-spacing-rows.html"));
    let r = |id: &str| get(&els, id).rect.clone().unwrap();
    let (t, b, row, row2, c, c2) = (r("t"), r("b"), r("r"), r("r2"), r("c"), r("c2"));
    assert_eq!((c.x, c.y), (2.0, t.y + 1.0 + 25.0 + 2.0), "the cell sits in the spacing");
    assert_eq!((b.x, b.w), (t.x, t.w), "tbody spans the content box");
    assert_eq!(b.y, t.y + 26.0, "tbody starts at the content edge");
    assert_eq!(b.h, 2.0 + c.h + 2.0 + c2.h + 2.0, "spacing above, between and below the rows");
    assert_eq!((row.x, row.w, row.y, row.h), (t.x, t.w, c.y, c.h));
    assert_eq!((row2.x, row2.w, row2.y, row2.h), (t.x, t.w, c2.y, c2.h));
}

fn inspect_dark(html: &str) -> Vec<InspectedElement> {
    let dark = mailvault_render::dark::DarkTheme { bg: "#0a0a12".into(), fg: "#e8e8ef".into(), brightness: 100.0, contrast: 100.0, sepia: 0.0, top_level: false };
    RenderDoc::open(html, RenderOptions { dark: Some(dark), ..RenderOptions::new(400, 1.0) }, None).unwrap().inspect()
}

/// A table with a non-zero `border` attribute gives its cells `border-color: inherit`
/// along with the 1px inset border (HTML Standard, Rendering 15.3.8; WebKit's shared
/// cell style). Dark Reader sets `table { border-color }` itself, so the harness
/// iframe's cells (td, th) carry the table's rgb(87, 92, 92) while Blitz gave them
/// currentcolor (ours/table-border-attr, dark: 80 diffs). A table with border=0 gets
/// no hint, so its cell keeps currentcolor.
#[test]
fn cells_of_a_bordered_table_inherit_the_table_border_colour() {
    for els in [inspect(&fx("table-border-attr-cell-colour.html")), inspect_dark(&fx("table-border-attr-cell-colour.html"))] {
        let table = get(&els, "t").border_top_color;
        assert_ne!(table, get(&els, "a").color, "the guard: the cell's own text colour differs");
        for id in ["a", "h"] {
            let cell = get(&els, id);
            for got in [cell.border_top_color, cell.border_right_color, cell.border_bottom_color, cell.border_left_color] {
                assert_eq!(got, table, "{id} takes the table's border colour");
            }
        }
        assert_eq!(get(&els, "c").border_top_color, get(&els, "c").color, "border=0 adds no hint: currentcolor");
    }
}

/// A `<br>` ends its line but does not start another: `text<br>` is one line, `<br>` alone
/// is one empty line and `a<br><br>` two (CSS 2 9.4.2; the harness iframe, ours/table-border-attr:
/// `</table><br><table>` is exactly one 22px line between the tables, Blitz 44). parley
/// treats a trailing newline like a text editor and adds an empty last line.
#[test]
fn a_trailing_br_does_not_add_a_line() {
    let els = inspect(&fx("br-ends-the-line.html"));
    let h = |id: &str| get(&els, id).rect.clone().unwrap().h;
    assert_eq!((h("trail"), h("lone"), h("two"), h("mid")), (22.0, 22.0, 44.0, 44.0));
    let (t1, t2) = (get(&els, "t1").rect.clone().unwrap(), get(&els, "t2").rect.clone().unwrap());
    assert_eq!(t2.y - (t1.y + t1.h), 22.0, "one line holds the br between two tables");
}

/// `line-height: normal` is the font's own line spacing, ascent + descent + line gap with each
/// part rounded (CSS Inline 3; WebKit's `fontMetrics().lineSpacing()`), not 1.2 em. Arial is
/// 14px high at 12px, 16 at 14px and 18 at 16px; the harness iframe has every 14px Arial cell of
/// ours/table-border-attr and table-cell-edges 16px of text (Blitz 16.8, 0.8px a line). A line
/// holding only a smaller span still has the block's strut, and a fixed line-height of the block
/// is a floor for a `normal` span.
#[test]
fn line_height_normal_follows_the_font_metrics() {
    let els = inspect(&fx("line-height-normal.html"));
    let h = |id: &str| get(&els, id).rect.clone().unwrap().h;
    assert_eq!((h("a12"), h("a14"), h("a16")), (14.0, 16.0, 18.0));
    assert_eq!(h("mixed"), 16.0, "a smaller span on a line with the block's own text");
    assert_eq!(h("small"), 18.0, "the strut of the 16px block holds a line with only an 11px span");
    assert_eq!(h("fixed"), 22.0, "the block's 22px line-height floors the span");
}

/// Text widths are fractional: WebKit lays a run out at its advance to 1/64 px (LayoutUnit),
/// blitz-dom rounded every content width up to a whole px, which added up across a row
/// (leemunroe: a cell 4.45 wide came out 5, the button table 4.6 wider). Harness iframe
/// (ours/table-border-attr, wide): table 244.44, cells 162.39 and 74.05 at 14px Arial.
#[test]
fn text_content_widths_are_not_rounded_up_to_whole_pixels() {
    let els = inspect_at(&fx("fractional-text-widths.html"), 576);
    let w = |id: &str| get(&els, id).rect.clone().unwrap().w;
    for (id, iframe) in [("t", 244.44), ("c1", 162.39), ("c2", 74.05)] {
        assert!((w(id) - iframe).abs() <= 0.25, "{id}: {}, iframe {iframe}", w(id));
    }
}

/// A cell's percentage `width` in auto table layout is its column's share of the table
/// (CSS 2 17.5.2.2; WebKit AutoTableLayout): cerberus `th width="33.33%"` / `"66.66%"`
/// columns of a `table` with `width: auto !important` (the base sheet) in a 508px cell.
/// Harness iframe (cerberus responsive, wide): th 169.34375 and 338.671875, Blitz 73.5 and
/// 434.5 (the percentage was ignored and the image column squeezed). The second table has the
/// percentages on its second row, as postmark's invoice does.
#[test]
fn percentage_columns_take_their_share_of_the_table() {
    let els = inspect_at(&fx("table-percent-columns.html"), 508);
    let w = |id: &str| get(&els, id).rect.clone().unwrap().w;
    for (id, want) in [
        ("t", 508.0),
        ("a", 169.34),
        ("b", 338.67),
        ("ta", 169.34),
        // postmark invoice: the percentages are on the second row's cells (iframe: table
        // 238.95 in a 239 cell, cells 191.17 and 47.80 at 80% / 20%).
        ("v", 508.0),
        ("v1", 406.4),
        ("v2", 101.6),
    ] {
        assert!((w(id) - want).abs() <= 1.0, "{id}: {}, want {want}", w(id));
    }
    // Postmark's invoice, whose percentage table sits in a spanning cell of a table that is
    // as wide as its first row (iframe: both 238.9, columns 191.17 and 47.80). A percentage
    // does not widen the table to what the column's content would need at that share.
    let (p, row, nested) = (w("p"), w("p1") + w("p2"), w("pn"));
    assert!((p - row).abs() <= 1.0 && (nested - p).abs() <= 1.0, "table {p}, first row {row}, nested table {nested}");
    assert!((w("pn1") - 0.8 * nested).abs() <= 1.0, "pn1 {} of {nested}", w("pn1"));
}

/// WebKit resolves `ui-monospace` to the system monospaced font (SF Mono's system cut), 85.64
/// wide at 12.59375px for "inline code" (NSFont.monospacedSystemFont; the harness iframe's
/// 93.68 minus the 8px of padding), where Blitz fell through the list to Menlo (83.40).
#[cfg(target_os = "macos")]
#[test]
fn ui_monospace_is_the_system_monospaced_font() {
    let els = inspect(&fx("inline-padding-and-ui-monospace.html"));
    let w = get(&els, "mono").rect.clone().unwrap().w - 8.0;
    assert!((w - 85.64).abs() <= 0.5, "ui-monospace text: {w}, system monospaced 85.64");
}

/// getBoundingClientRect of an inline is its border box: the text's content area (rounded
/// ascent + descent) plus the element's own padding and border. Harness iframe
/// (ours/basic-typography, `code { padding: 1px 4px }`, 12.6px): 93.68 x 17 for the text
/// "inline code", which Blitz reported without the padding (83.4 x 14.7).
#[test]
fn an_inline_rect_includes_its_padding() {
    let els = inspect(&fx("inline-padding-and-ui-monospace.html"));
    let r = |id: &str| get(&els, id).rect.clone().unwrap();
    let (plain, padded) = (r("plain"), r("padded"));
    assert_eq!((padded.w - plain.w, padded.h - plain.h), (8.0, 2.0), "1px 4px of padding");
}

/// The harness counts lines the way `Range.getClientRects` sees them: one rect per text
/// fragment, as high as the font's content area, merged when a fragment's middle lies inside
/// the rect before it. Two columns of one line each, top-aligned, with line-heights 40 and
/// 20: the text sits at 12.5-27.5 and 2.5-17.5, the second one's middle (20) outside the
/// first's, so two lines. Their line boxes (0-40, 0-20) would merge into one.
#[test]
fn line_count_follows_text_fragments_not_line_boxes() {
    let els = inspect(&fx("inline-padding-and-ui-monospace.html"));
    assert_eq!(get(&els, "cols").line_count, Some(2));
}

/// WebKit on macOS raises the ascent of Times, Helvetica and Courier (the default serif,
/// sans-serif and monospace) by 15% of ascent + descent, rounded, "to closely match the vertical
/// metrics of their Microsoft counterparts" (FontCocoa `platformInit`). Helvetica at 14px is
/// ascent 13 + descent 3: `line-height: normal` is 16, not 14, and under `line-height: 22px` the
/// strut below the baseline is 6, not 7 (harness iframe, cerberus: a cell holding an image
/// 39.375 high is 45 high and one holding a 50px image is 56; Blitz 46.4 and 57). Arial has no
/// such adjustment: 16 and 6 from its own metrics.
#[cfg(target_os = "macos")]
#[test]
fn helvetica_has_the_webkit_ascent_adjustment() {
    let els = inspect(&fx("webkit-helvetica-metrics.html"));
    let h = |id: &str| get(&els, id).rect.clone().unwrap().h;
    assert_eq!((h("n12"), h("n14"), h("n16")), (14.0, 16.0, 18.0), "line-height: normal");
    assert_eq!(h("arial"), 16.0, "Arial is not adjusted");
    assert_eq!(h("img"), 56.0, "50px image + 6px strut under Helvetica 14px/22px");
    assert_eq!(h("img-arial"), 56.0, "Arial: 13 + 3, leading 6, the same 6");
}

/// `<font face>` is a font-family list and `<font size>` a font-size keyword (HTML Standard,
/// Rendering, "The font element"). Blitz ignored both: the harness iframe sets
/// `<font face="Arial">Red font tag</font>` 76.28 wide (ours/tables-legacy), Blitz 79.24 in the
/// body font. The widths are compared with the same text in the equivalent CSS.
#[test]
fn font_face_and_size_attributes_map_to_css() {
    let els = inspect(&fx("font-face-size.html"));
    let w = |id: &str| get(&els, id).rect.clone().unwrap().w;
    assert_eq!(w("face"), w("arial"));
    assert_ne!(w("face"), w("times"), "the guard: the body font is another one");
    assert_eq!(w("list"), w("arial"), "the first family that exists is used");
    assert_eq!(w("size5"), w("xl"), "size=5 is x-large");
    assert_eq!(w("plus1"), w("lg"), "size=+1 is 4, large");
}

/// The harness counts lines over the text nodes that have something in them and a rect with a
/// height. A cell with `font-size: 0` (cerberus uses it to close the gaps between its inline-block
/// columns) holds only whitespace of its own, in a font with no height; those runs are not lines
/// (cerberus hybrid, wide: tr 5 lines in the iframe, 6 here).
#[test]
fn whitespace_in_a_font_size_zero_cell_adds_no_line() {
    let els = inspect_at(&fx("line-count-font-size-zero.html"), 576);
    let lines = |id: &str| get(&els, id).line_count;
    assert_eq!(lines("cell"), Some(2 + lines("p").unwrap()), "two lines in the first column plus the paragraph's");
}

/// A box that contains its floats (a table cell, `display: flow-root`) is as tall as its lowest
/// float plus the padding and border below it. Blitz ended it at the float (cerberus responsive,
/// harness iframe: a cell with `padding: 10px` ending in a `float: left` button table, th 185;
/// Blitz 175).
#[test]
fn a_box_holding_a_float_keeps_its_bottom_padding() {
    let els = inspect(&fx("float-in-a-cell.html"));
    let h = |id: &str| get(&els, id).rect.clone().unwrap().h;
    assert_eq!(h("cell"), 10.0 + 20.0 + 10.0 + 43.0 + 10.0, "padding, text, margin, float, padding");
    assert_eq!(h("root"), 10.0 + 20.0 + 43.0 + 7.0 + 3.0, "padding-top, block, float, padding-bottom, border-bottom");
}

/// A cell spanning columns only widens them by what they lack, in proportion to their own
/// maximum content (WebKit AutoTableLayout, spanning cells), not equally as taffy's grid does.
/// ours/table-cell-edges: three auto columns over a `colspan="3"` cell holding a table 333.27
/// wide. Harness iframe (wide): table 351.25, columns 125.22, 114.31 and 111.73; Blitz
/// 123.5, 114.5 and 112.9.
#[test]
fn a_spanning_cell_widens_columns_in_proportion_to_their_content() {
    let els = inspect_at(&fx("table-colspan-columns.html"), 576);
    let w = |id: &str| get(&els, id).rect.clone().unwrap().w;
    for (id, iframe) in [("t", 351.25), ("a1", 125.22), ("a2", 114.31), ("a3", 111.73), ("c", 351.27)] {
        assert!((w(id) - iframe).abs() <= 0.6, "{id}: {}, iframe {iframe}", w(id));
    }
}

/// `word-break: break-word` means `overflow-wrap: anywhere` (CSS Text 3), which lets a token break
/// at any letter when the column's minimum width is worked out. stylo's servo build does not know
/// the value and dropped the declaration, so a cell of Postmark's (it has the declaration on every
/// cell) was as wide as its longest token; the harness iframe's 20% invoice column is 47.8px, the
/// token's own width is ~75. Declarations in `style` attributes and `<style>` elements change;
/// the same words in the text of the mail do not.
#[test]
fn word_break_break_word_lets_a_token_break_anywhere() {
    let html = fx("word-break-break-word.html");
    let els = inspect_at(&html, 400);
    let w = |id: &str| get(&els, id).rect.clone().unwrap().w;
    assert!(w("a") <= 100.0, "style attribute: {}", w("a"));
    assert!(w("c") <= 100.0, "style element: {}", w("c"));
    assert!(w("b") > 100.0, "the guard: without it the token is {} wide", w("b"));
    let text = RenderDoc::open(&html, RenderOptions { css_width: 400, scale: 1.0, ..Default::default() }, None).unwrap().meta().plain_text;
    assert!(text.contains("word-break: break-word is only text here"), "{text}");
    assert_eq!(
        mailvault_render::compat::word_break_break_word(r#"<td style="WORD-BREAK :  Break-Word !important">x"#),
        r#"<td style="overflow-wrap:anywhere !important">x"#
    );
}

/// CSS 2.1 10.8.1: an `inline-block` with no in-flow line box of its own has its bottom
/// margin edge on the baseline, so the line box still has the strut below it. A `table`
/// made `display: inline-block` by a media query holds only table boxes, no line box
/// (cerberus button wrapper at 15px/20px sans-serif: the iframe's cell is 5px taller than
/// the table, Blitz had 0). An inline-block with a line box of its own sits on that
/// baseline and reaches below the strut already.
#[test]
fn an_inline_block_table_sits_on_the_baseline_with_the_strut_below() {
    let els = inspect_at(&fx("inline-block-table-baseline.html"), 400);
    let r = |id: &str| get(&els, id).rect.clone().unwrap();
    assert_eq!(r("btn").h, 30.0);
    assert_eq!(r("cell").h, 10.0 + 30.0 + 5.0 + 10.0, "strut below the table: {}", r("cell").h);
    assert_eq!(r("btn").y - r("cell").y, 10.0, "the table sits at the top of the line");
    assert_eq!(r("cell2").h, 10.0 + r("box").h + 10.0, "a box with its own text line: no strut");
}
