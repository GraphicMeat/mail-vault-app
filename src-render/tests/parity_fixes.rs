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

/// The expected values below were measured in WebKit with Arial or Helvetica installed. An
/// unknown family falls back to the document font, so a machine without the font (ubuntu CI
/// has only DejaVu) lays the text out in another one and every width and metric differs. True
/// when one of `families` is a real font here: its text is wider or narrower than the same
/// text in a family that does not exist.
fn font_present(families: &[&str]) -> bool {
    const TEXT: &str = "Hamburgefonstiv WWW iii 0123456789";
    families.iter().any(|family| {
        let span = |id: &str, fam: &str| format!(r#"<span data-mv-id="{id}" style="font:20px '{fam}';display:inline-block">{TEXT}</span><br>"#);
        let html = format!(r#"<body style="margin:0">{}{}"#, span("probe", family), span("none", "mv-no-such-font-family"));
        let els = inspect(&html);
        let w = |id: &str| get(&els, id).rect.clone().unwrap().w;
        w("probe") != w("none")
    })
}

/// Test guard: false (with a note on stderr) when none of `families` is installed, and the
/// test returns early. Never used for what a test checks about the engine, only for numbers
/// that belong to one font.
fn require_font(families: &[&str]) -> bool {
    let present = font_present(families);
    if !present {
        eprintln!("skipped: none of {families:?} is installed, the expected widths and metrics are that font's");
    }
    present
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

/// The harness iframe lays a computed line-height out at whole px, truncated, so
/// `line-height: 1.6` is 22px at 14px, not 22.4. Blitz kept the
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
    if !require_font(&["Arial"]) {
        return;
    }
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
/// part rounded (CSS Inline 3; the rounding as measured in the harness iframe), not 1.2 em. Arial is
/// 14px high at 12px, 16 at 14px and 18 at 16px; the harness iframe has every 14px Arial cell of
/// ours/table-border-attr and table-cell-edges 16px of text (Blitz 16.8, 0.8px a line). A line
/// holding only a smaller span still has the block's strut, and a fixed line-height of the block
/// is a floor for a `normal` span.
#[test]
fn line_height_normal_follows_the_font_metrics() {
    if !require_font(&["Arial"]) {
        return;
    }
    let els = inspect(&fx("line-height-normal.html"));
    let h = |id: &str| get(&els, id).rect.clone().unwrap().h;
    assert_eq!((h("a12"), h("a14"), h("a16")), (14.0, 16.0, 18.0));
    assert_eq!(h("mixed"), 16.0, "a smaller span on a line with the block's own text");
    assert_eq!(h("small"), 18.0, "the strut of the 16px block holds a line with only an 11px span");
    assert_eq!(h("fixed"), 22.0, "the block's 22px line-height floors the span");
}

/// Text widths are fractional: the harness iframe lays a run out at its advance to 1/64 px,
/// blitz-dom rounded every content width up to a whole px, which added up across a row
/// (leemunroe: a cell 4.45 wide came out 5, the button table 4.6 wider). Harness iframe
/// (ours/table-border-attr, wide): table 244.44, cells 162.39 and 74.05 at 14px Arial.
#[test]
fn text_content_widths_are_not_rounded_up_to_whole_pixels() {
    if !require_font(&["Arial"]) {
        return;
    }
    let els = inspect_at(&fx("fractional-text-widths.html"), 576);
    let w = |id: &str| get(&els, id).rect.clone().unwrap().w;
    for (id, iframe) in [("t", 244.44), ("c1", 162.39), ("c2", 74.05)] {
        assert!((w(id) - iframe).abs() <= 0.25, "{id}: {}, iframe {iframe}", w(id));
    }
}

/// A cell's percentage `width` in auto table layout is its column's share of the table
/// (CSS 2 17.5.2.2; measured in the harness iframe): cerberus `th width="33.33%"` / `"66.66%"`
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

/// In the harness iframe (WKWebView on macOS) Times, Helvetica and Courier (the default serif,
/// sans-serif and monospace) have an ascent 15% of ascent + descent, rounded, above the font
/// file's. Helvetica at 14px is
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
    if !require_font(&["Arial"]) {
        return;
    }
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

/// A table cell is `vertical-align: middle` by default, which places the cell's content in the
/// cell and has no say over the lines inside it. blitz-dom beta.4 put it in the root text
/// style, and the span each `<br>` is pushed in inherited it, so every line a `<br>` ends was
/// 1px taller than its line-height (cerberus footer, 12px/15px: 145 high in the harness
/// iframe, 150 in Blitz).
#[test]
fn a_br_in_a_middle_aligned_cell_keeps_the_line_height() {
    let els = inspect(r#"<body style="margin:0"><table cellspacing="0" cellpadding="0"><tr><td data-mv-id="td" style="font:12px/15px sans-serif">a<br><br>b<br>c</td></tr></table></body>"#);
    assert_eq!(get(&els, "td").rect.clone().unwrap().h, 4.0 * 15.0);
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
/// maximum content (measured in the harness iframe), not equally as taffy's grid does.
/// ours/table-cell-edges: three auto columns over a `colspan="3"` cell holding a table 333.27
/// wide. Harness iframe (wide): table 351.25, columns 125.22, 114.31 and 111.73; Blitz
/// 123.5, 114.5 and 112.9.
#[test]
fn a_spanning_cell_widens_columns_in_proportion_to_their_content() {
    if !require_font(&["Arial"]) {
        return;
    }
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

/// CSS 2.1 10.3.9: the shrink-to-fit width of an inline-block is min(max(preferred minimum,
/// available), preferred), where the available width is the line's minus the box's margins,
/// so a negative margin gives room (cerberus hybrid `margin: 0 -1px` columns at 375: the
/// iframe's column is 325 wide in a 323 cell, Blitz filled only the cell).
#[test]
fn an_inline_block_with_negative_margins_fits_in_the_room_they_give() {
    let els = inspect_at(&fx("inline-block-negative-margin.html"), 400);
    let w = |id: &str| get(&els, id).rect.clone().unwrap().w;
    let near = |a: f64, b: f64| (a - b).abs() < 0.05;
    assert!(near(w("a"), 302.0), "300 + 2 for the -1px margins: {}", w("a"));
    assert!(near(w("b"), 298.0), "300 - 2 for the 1px margins: {}", w("b"));
    assert!(w("c") < 101.0, "short text stays at min-width: {}", w("c"));
    assert!(near(w("cell"), 300.0), "cell {}", w("cell"));
    assert!(near(w("d"), 282.0), "cell content 280 + 2: {}", w("d"));
}

/// The iframe's line count skips a text node `trim()` empties, and JS `trim` strips a lone
/// no-break space. blitz-dom keeps a nbsp from collapsing by wrapping it in word joiners
/// (U+2060), which Rust's `trim` leaves: a `<td>&nbsp;</td>` spacer added a line to its row
/// (leemunroe: 14 lines in the table, the iframe 13).
#[test]
fn a_nbsp_spacer_cell_adds_no_line_to_its_row() {
    let els = inspect(&fx("nbsp-at-text-edges.html"));
    assert_eq!(get(&els, "spacer").line_count, None);
    assert_eq!(get(&els, "word").line_count, Some(1));
    assert_eq!(get(&els, "row").line_count, Some(1));
}

/// CSS Text 3 4.1.3: a collapsible space at the end of a line is removed, before a forced
/// break and before a soft wrap alike. Harness iframe (leemunroe footer, 16px Helvetica):
/// the cell holding `<span>Company Inc, 7-11 Commercial Ct, Belfast BT1 2NB</span>\n<br>` is
/// 371.4 wide, the span's own box 371.398. Blitz counted the space before the `br` in the
/// max-content width (375.9).
#[test]
fn a_space_before_a_forced_break_takes_no_max_content_width() {
    if !require_font(&["Helvetica","Arial"]) {
        return;
    }
    let els = inspect(&fx("trailing-space-at-line-end.html"));
    let w = |id: &str| get(&els, id).rect.clone().unwrap().w;
    assert!((w("s") - 371.398).abs() < 0.1, "span {}", w("s"));
    assert!((w("box") - 371.406).abs() < 0.1, "float shrink-to-fit around a line ending in a space and a br: {}", w("box"));
    let h = get(&els, "box").rect.clone().unwrap().h;
    assert_eq!(h, 36.0, "two lines: the box is exactly as wide as the first, whose space hangs");
}

/// The same rule at a soft wrap: the first line of the leemunroe footer span is "... Belfast"
/// and the iframe's `getBoundingClientRect` of the span is 302.04 wide, the width of the text
/// without the collapsed space the line wrapped at (Blitz: 306.48, the glyph run's advance).
#[test]
fn a_wrapped_inline_box_excludes_the_space_its_line_wrapped_at() {
    if !require_font(&["Helvetica","Arial"]) {
        return;
    }
    let els = inspect(&fx("trailing-space-at-line-end.html"));
    let w = get(&els, "wrapped").rect.clone().unwrap().w;
    assert!((w - 302.04).abs() < 0.1, "wrapped span, widest line without its trailing space: {w}");
}

// ---- Plan D, Task 13b: table widths and collapsed borders -------------------------------------

/// The table `t` of `table_html` laid out alone in a 300px container (the chat bubble's
/// inner width), next to a `table{max-width:100%}` rule like `buildChatBubbleDocument`'s.
fn table_in_300(table_html: &str) -> Vec<InspectedElement> {
    let html = format!(
        r#"<body style="margin:0"><style>table{{max-width:100%}}</style><div style="width:300px">{table_html}</div></body>"#
    );
    inspect_at(&html, 300)
}

/// A table's `min-width` / `max-width`. CSS 2.1 10.4 leaves both undefined for tables, so the
/// expected widths are WKWebView's, measured with `getBoundingClientRect` on `<table
/// style="..." cellspacing=0 cellpadding=0>` in a 300px `div` (macOS WKWebView, 2026-10-15).
/// WebKit honours `min-width` and a length `max-width` and also a percentage `max-width` on an
/// auto or percentage width table, but ignores a percentage `max-width` when the table's
/// `width` is a length (attribute or CSS): `width=600` with `max-width:100%` stays 600 and
/// overflows. Blitz clamped it to the container (268 in the bubble). The cases Blitz already
/// matched are pinned here too, so the fix cannot widen what it drops.
#[test]
fn a_table_with_a_length_width_ignores_a_percentage_max_width() {
    let row = "<tr><td>a</td><td>b</td></tr>";
    let long = "<tr><td>lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore</td></tr>";
    // (attributes and style of the table, rows, WebKit's width)
    let cases: &[(&str, &str, f64)] = &[
        // Length width + percentage max-width: ignored.
        (r#"width="600""#, row, 600.0),
        (r#"style="width:600px""#, row, 600.0),
        (r#"width="600" style="max-width:50%""#, row, 600.0),
        (r#"width="600" style="max-width:100%""#, row, 600.0),
        (r#"style="width:600px;max-width:50%""#, row, 600.0),
        (r#"style="width:400px;max-width:50%""#, row, 400.0),
        (r#"style="width:400px;max-width:75%""#, row, 400.0),
        (r#"style="width:400px;max-width:100%""#, row, 400.0),
        (r#"width="600" style="max-width:100%""#, long, 600.0),
        // Length max-width: honoured with a length width.
        (r#"width="600" style="max-width:300px""#, row, 300.0),
        (r#"width="600" style="max-width:200px""#, row, 200.0),
        (r#"width="400" style="max-width:200px""#, row, 200.0),
        // Percentage max-width: honoured with an auto or percentage width.
        (r#"style="max-width:50%""#, long, 150.0),
        (r#"width="100%" style="max-width:50%""#, row, 150.0),
        (r#"width="50%" style="max-width:100px""#, row, 100.0),
        (r#"style="max-width:200px""#, long, 200.0),
        (r#""#, long, 300.0),
        // The reader template's `width:auto !important; max-width:100% !important`.
        (r#"width="600" style="width:auto !important;max-width:100% !important""#, long, 300.0),
        // The auto table cannot be narrower than its content, and a wide fixed div is content.
        (r#""#, "<tr><td><div style=\"width:600px\">x</div></td></tr>", 600.0),
        (r#"style="max-width:200px""#, "<tr><td><div style=\"width:100px\">x</div></td></tr>", 100.0),
        (r#"style="max-width:200px""#, "<tr><td><div style=\"width:260px\">x</div></td></tr>", 260.0),
        // min-width is honoured (not part of this fix, pinned so it stays so).
        (r#"style="width:100px;min-width:400px""#, "<tr><td>a</td></tr>", 400.0),
        (r#"style="min-width:250px""#, "<tr><td>a</td></tr>", 250.0),
        (r#"style="min-width:400px""#, "<tr><td>a</td></tr>", 400.0),
        (r#"width="100%" style="min-width:100%""#, "<tr><td>a</td></tr>", 300.0),
    ];
    let mut wrong = Vec::new();
    for (attrs, rows, expected) in cases {
        let els = table_in_300(&format!(r#"<table data-mv-id="t" {attrs} cellspacing="0" cellpadding="0">{rows}</table>"#));
        let w = get(&els, "t").rect.clone().unwrap().w;
        if (w - expected).abs() > 0.51 {
            wrong.push(format!("<table {attrs}>: WebKit {expected}, Blitz {w}"));
        }
    }
    assert!(wrong.is_empty(), "table widths differ from WebKit:\n{}", wrong.join("\n"));
}

/// The layout-in-a-layout shape of the corpus (`ours/tables-legacy`, `ours/table-cell-edges`): a
/// `width="100%"` table whose only cell holds a fixed-width table (`width="600"`, `"400"`), in
/// the chat bubble's 268px column with its `table { max-width: 100%; border-collapse: collapse
/// }`. A table's used width is never below its minimum content width (CSS 2.1 17.5.2), so
/// WKWebView measures the outer table at 600 (400) and overflows; Blitz laid it out at 268.
/// Expected values are the harness iframe's (`table[1]` w 600 and 400) and the same shape
/// measured alone in WKWebView (2026-10-15): outer `width=100%`, auto and `width:50%`, with or
/// without `border-collapse`, inner 600 or 400: the outer and inner table are both 600 (400);
/// with the reader's `width:auto !important` both are 54 (the inner shrinks to its content);
/// an inner 200 table leaves the outer at 268.
#[test]
fn a_percentage_width_table_is_never_narrower_than_its_content() {
    let nested = |inner_width: u32, collapse: bool, outer_attr: &str| {
        let css = if collapse { "table{max-width:100%;border-collapse:collapse}" } else { "table{max-width:100%}" };
        let html = format!(
            r#"<body style="margin:0"><style>{css}</style><div style="width:268px"><table data-mv-id="o" {outer_attr} cellpadding="0" cellspacing="0" border="0"><tr><td align="center"><table data-mv-id="i" width="{inner_width}" cellpadding="10" cellspacing="0" border="0"><tr><td>x</td><td>y</td></tr></table></td></tr></table></div></body>"#
        );
        let els = inspect_at(&html, 268);
        let w = |id: &str| get(&els, id).rect.clone().unwrap().w;
        (w("o"), w("i"))
    };
    for collapse in [false, true] {
        assert_eq!(nested(600, collapse, r#"width="100%""#), (600.0, 600.0), "600 inner, collapse {collapse}");
        assert_eq!(nested(400, collapse, r#"width="100%""#), (400.0, 400.0), "400 inner, collapse {collapse}");
        // An auto-width outer table, and the reader's `width:auto !important` ones.
        assert_eq!(nested(600, collapse, "").0, 600.0, "auto outer, collapse {collapse}");
        assert_eq!(nested(600, collapse, r#"style="width:50%""#).0, 600.0, "50% outer, collapse {collapse}");
    }
    // The reader template: both tables are auto width, so the inner one shrinks to its content
    // and nothing holds the outer table open.
    let html = r#"<body style="margin:0"><style>table{max-width:100% !important;width:auto !important}</style><div style="width:268px"><table data-mv-id="o" width="100%"><tr><td><table data-mv-id="i" width="600"><tr><td>x</td></tr></table></td></tr></table></div></body>"#;
    let els = inspect_at(html, 268);
    assert!(get(&els, "o").rect.clone().unwrap().w <= 268.0, "reader outer table stays in its column");
    assert!(get(&els, "i").rect.clone().unwrap().w < 100.0, "reader inner table shrinks to its content");
    // Content that fits changes nothing.
    let html = r#"<body style="margin:0"><style>table{max-width:100%}</style><div style="width:268px"><table data-mv-id="o" width="100%"><tr><td><table data-mv-id="i" width="200"><tr><td>x</td></tr></table></td></tr></table></div></body>"#;
    let els = inspect_at(html, 268);
    assert_eq!(get(&els, "o").rect.clone().unwrap().w, 268.0);
}

/// The newsletter hero: `<table><tr><td><img width="600" height="50"></td></tr></table>` in a
/// narrower container. A replaced element with `max-width: 100%` is compressible (CSS Sizing 3
/// 5.2.2: its min-content contribution is 0), so the table is not held open by the image's
/// 600px. Measured in macOS WKWebView, 2026-10-15, with the reader's `table { max-width: 100%
/// !important; width: auto !important }` and `img { max-width: 100% }`: in a 375px `div` the
/// table is 375 wide and the image 369 (3px cell padding); in 300px, 300 and 294; with
/// `cellspacing=0 cellpadding=0` the image is the full container width. The same table with
/// no `img { max-width }` rule (not compressible) is 606 wide, the image 600. The bubble's
/// shape (`table { max-width: 100% }` alone, no `!important`, auto width) measured the same.
/// The min-content floor (`min_content_floor`) must not widen the first two.
#[test]
fn a_compressible_image_does_not_hold_a_table_open() {
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    let page = |css: &str, container: u32, table_attrs: &str| {
        let html = format!(
            r#"<body style="margin:0"><style>{css}</style><div style="width:{container}px"><table data-mv-id="t" {table_attrs}><tr><td><img data-mv-id="i" width="600" height="50" src="data:image/png;base64,{PNG}"></td></tr></table></div></body>"#
        );
        let els = inspect_at(&html, container);
        let w = |id: &str| get(&els, id).rect.clone().unwrap().w;
        (w("t"), w("i"))
    };
    let reader = "table{max-width:100%!important;width:auto!important}img{max-width:100%}";
    let bubble = "table{max-width:100%}img{max-width:100%}";
    for (css, container, attrs, expected) in [
        (reader, 375, "", (375.0, 369.0)),
        (reader, 300, "", (300.0, 294.0)),
        (reader, 375, r#"cellspacing="0" cellpadding="0""#, (375.0, 375.0)),
        (reader, 375, r#"width="600""#, (375.0, 369.0)),
        (bubble, 375, "", (375.0, 369.0)),
        (bubble, 300, "", (300.0, 294.0)),
        ("table{max-width:100%!important;width:auto!important}", 375, "", (606.0, 600.0)),
        ("table{max-width:100%}", 300, "", (606.0, 600.0)),
    ] {
        let got = page(css, container, attrs);
        assert!(
            (got.0 - expected.0).abs() <= 0.51 && (got.1 - expected.1).abs() <= 0.51,
            "{css} in {container}px, table {attrs:?}: WebKit (table, img) {expected:?}, Blitz {got:?}"
        );
    }
}

/// The bubble's shape: a 600px table of three 200px cells in a 300px container keeps its cells
/// (WebKit: table 600, cells 200 / 200 / 200 at x = 0, 200, 400) whether the width comes from
/// the attribute, the style, or both.
#[test]
fn a_fixed_width_table_in_a_narrow_container_keeps_its_columns() {
    for table in [
        r#"<table data-mv-id="t" width="600" cellspacing="0" cellpadding="0">"#,
        r#"<table data-mv-id="t" style="width:600px" cellspacing="0" cellpadding="0">"#,
    ] {
        let els = table_in_300(&format!(
            r#"{table}<tr><td data-mv-id="a" style="width:200px">a</td><td data-mv-id="b" style="width:200px">b</td><td data-mv-id="c" style="width:200px">c</td></tr></table>"#
        ));
        let r = |id: &str| {
            let r = get(&els, id).rect.clone().unwrap();
            (r.x, r.w)
        };
        assert_eq!(r("t"), (0.0, 600.0), "{table}");
        assert_eq!((r("a"), r("b"), r("c")), ((0.0, 200.0), (200.0, 200.0), (400.0, 200.0)), "{table}");
    }
}

/// The first tile of a painted table page: size in device pixels, RGB bytes and the border
/// box of the table `t` in device pixels.
struct Painted {
    w: u32,
    h: u32,
    rgb: Vec<u8>,
    /// (x0, y0, x1, y1), exclusive at x1 and y1.
    rect: (u32, u32, u32, u32),
}

impl Painted {
    fn px(&self, x: u32, y: u32) -> [u8; 3] {
        let i = ((y * self.w + x) * 3) as usize;
        [self.rgb[i], self.rgb[i + 1], self.rgb[i + 2]]
    }
    /// The first `limit` pixels (x, y, rgb) for which `bad` holds.
    fn pixels_where(&self, bad: impl Fn(u32, u32, [u8; 3]) -> bool, limit: usize) -> Vec<(u32, u32, [u8; 3])> {
        let mut found = Vec::new();
        'all: for y in 0..self.h {
            for x in 0..self.w {
                let p = self.px(x, y);
                if bad(x, y, p) {
                    found.push((x, y, p));
                    if found.len() >= limit {
                        break 'all;
                    }
                }
            }
        }
        found
    }
}

/// Decoded RGB of the first tile of `body` in a white 300px page, at `scale`, with the
/// table `t`'s border box in device pixels.
fn paint_table(body: &str, scale: f32) -> Painted {
    let html = format!(r#"<body style="margin:0;background:#fff"><div style="width:300px">{body}</div></body>"#);
    let mut doc = RenderDoc::open(&html, RenderOptions { css_width: 300, scale, ..Default::default() }, None).unwrap();
    let r = doc.inspect().into_iter().find(|e| e.mv_id == "t").unwrap().rect.unwrap();
    let png = doc.tile_png(0).unwrap();
    let mut reader = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
    let mut rgb = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut rgb).unwrap();
    assert_eq!(info.color_type, png::ColorType::Rgb);
    let s = scale as f64;
    let rect = ((r.x * s).round() as u32, (r.y * s).round() as u32, ((r.x + r.w) * s).round() as u32, ((r.y + r.h) * s).round() as u32);
    Painted { w: info.width, h: info.height, rgb, rect }
}

fn near(a: [u8; 3], b: [u8; 3]) -> bool {
    a.iter().zip(b).all(|(x, y)| (*x as i32 - y as i32).abs() <= 1)
}

const WHITE: [u8; 3] = [255, 255, 255];
const CCC: [u8; 3] = [204, 204, 204];

/// CSS 2.1 17.6.2: in the collapsing border model a border whose style is `none` (the
/// initial value) has the lowest priority and contributes nothing, and CSS Backgrounds 3 4.3
/// gives such a border a used width of 0, although the computed `border-width` is still
/// `medium` (3px). The paint code for collapsed borders took the first cell's computed width
/// and `currentcolor`, so every cerberus table, the export header's `.mv-meta` and the chat
/// bubble's tables had a 3px dark frame (WKWebView: nothing). The page is white, so every
/// pixel must stay white, inside and outside the table's box.
#[test]
fn a_collapsed_table_without_borders_paints_no_border_pixels() {
    for scale in [1.0f32, 2.0] {
        let img = paint_table(
            r#"<table data-mv-id="t" style="border-collapse:collapse;width:100px"><tr><td style="height:20px"></td><td></td></tr><tr><td style="height:10px"></td><td></td></tr></table>"#,
            scale,
        );
        let rect = img.rect;
        assert!(rect.2 > rect.0 && rect.3 > rect.1, "table box {rect:?}");
        let dark = img.pixels_where(|_, _, p| !near(p, WHITE), 8);
        assert!(dark.is_empty(), "scale {scale}: table box {rect:?}, first non-white pixels {dark:?}");
    }
}

/// The table's own `border: 1px solid #ccc` under `border-collapse: collapse` (the borderless
/// cells do not add to it): WKWebView draws a 1 CSS px #ccc line on each side, inside the
/// table's box, and nothing else. Measured: a 100px table at the page origin has #ccc on
/// column 0 and 99 and rows 0 and (height - 1) and white everywhere else.
#[test]
fn a_collapsed_table_border_paints_one_css_px_in_its_colour() {
    for scale in [1.0f32, 2.0] {
        let img = paint_table(
            r#"<table data-mv-id="t" style="border-collapse:collapse;width:100px;border:1px solid #ccc"><tr><td style="height:20px"></td><td></td></tr></table>"#,
            scale,
        );
        let (x0, y0, x1, y1) = img.rect;
        let band = scale as u32;
        let bad = img.pixels_where(
            |x, y, p| {
                let inside = x >= x0 && x < x1 && y >= y0 && y < y1;
                let on_ring = inside && (x < x0 + band || x >= x1 - band || y < y0 + band || y >= y1 - band);
                !near(p, if on_ring { CCC } else { WHITE })
            },
            8,
        );
        assert!(bad.is_empty(), "scale {scale}: table box {:?}, first wrong pixels (x, y, got) {bad:?}", img.rect);
    }
}

/// Collapsed borders given by the cells (`td { border: 1px solid #ccc }`, the usual data
/// table): nothing darker than #ccc anywhere and nothing outside the table's box. This is a
/// characterization test: it passes on the code before the border fix too, because a first
/// cell with a real 1px border already painted a 1px #ccc ring (the 3px dark frame needed a
/// borderless first cell). It guards the fix against regressing that shape.
#[test]
fn collapsed_cell_borders_paint_in_their_colour_inside_the_table_box() {
    for scale in [1.0f32, 2.0] {
        let img = paint_table(
            r#"<table data-mv-id="t" style="border-collapse:collapse;width:100px"><tr><td style="height:20px;border:1px solid #ccc"></td><td style="border:1px solid #ccc"></td></tr></table>"#,
            scale,
        );
        let (x0, y0, x1, y1) = img.rect;
        let dark = img.pixels_where(|_, _, p| p.iter().any(|c| *c < 203), 8);
        let outside = img.pixels_where(|x, y, p| !(x >= x0 && x < x1 && y >= y0 && y < y1) && !near(p, WHITE), 8);
        assert!(dark.is_empty(), "scale {scale}: darker than #ccc {dark:?}");
        assert!(outside.is_empty(), "scale {scale}: table box {:?}, pixels outside it {outside:?}", img.rect);
        // The top and left lines are one CSS px of #ccc, solid at least up to two borders from
        // the far end (they reach it with blitz-paint beta.4, see
        // `collapsed_cell_borders_ring_the_table_box_on_its_outermost_pixels`).
        let band = scale as u32;
        assert!((x0..x1 - 2 * band).all(|x| (0..band).all(|d| near(img.px(x, y0 + d), CCC))), "scale {scale}: top line");
        assert!((y0..y1 - 2 * band).all(|y| (0..band).all(|d| near(img.px(x0 + d, y), CCC))), "scale {scale}: left line");
    }
}

const DDD: [u8; 3] = [221, 221, 221];

/// The usual row-separator table: `td { border-bottom: 1px solid #ddd }` under
/// `border-collapse: collapse`. Before the fix its first cell's computed top border (3px
/// `currentcolor`) framed the whole table in black. The inner separators (between the rows)
/// are `scale` px of #ddd, and nothing on the page is darker than #ddd.
#[test]
fn collapsed_row_separators_paint_in_their_colour() {
    for scale in [1.0f32, 2.0] {
        let img = paint_table(ROW_SEPARATORS, scale);
        let (x0, y0, x1, y1) = img.rect;
        let band = scale as u32;
        let dark = img.pixels_where(|_, _, p| p.iter().any(|c| *c < 220), 8);
        assert!(dark.is_empty(), "scale {scale}: darker than #ddd {dark:?}");
        let x = x0 + (x1 - x0) / 4;
        let rows: Vec<u32> = (y0..y1).filter(|y| !near(img.px(x, *y), WHITE)).collect();
        assert_eq!(rows.len() as u32, 2 * band, "scale {scale}: two separators of {band}px each, at rows {rows:?}");
        assert!(rows.iter().all(|y| near(img.px(x, *y), DDD)), "scale {scale}: separator colour, rows {rows:?}");
        let (first, second) = rows.split_at(band as usize);
        assert!(first.windows(2).all(|w| w[1] == w[0] + 1) && second.windows(2).all(|w| w[1] == w[0] + 1), "scale {scale}: each separator is {band}px thick: {rows:?}");
        assert!(first[0] > y0 + 2 * band && second[second.len() - 1] < y1 - band, "scale {scale}: between the rows {rows:?}");
        // Each separator runs across the table (it stops short of the far corner, see below).
        for y in [first[0], second[0]] {
            assert!((x0..x1 - 2 * band).all(|x| near(img.px(x, y), DDD)), "scale {scale}: separator at row {y} spans the table");
        }
    }
}

const ROW_SEPARATORS: &str = r#"<style>td{border-bottom:1px solid #ddd}</style><table data-mv-id="t" style="border-collapse:collapse;width:100px"><tr><td style="height:10px"></td><td></td></tr><tr><td style="height:10px"></td><td></td></tr><tr><td style="height:10px"></td><td></td></tr></table>"#;

/// Collapsed cell borders (`td { border: 1px solid #ccc }`) ring the table on the outermost
/// pixels of its box, as in WKWebView (columns 0 and 99 of a 100px table). blitz-paint beta.2
/// measured the outer lines from the track area, so the right and bottom lines sat one border
/// inside the box and the top and left lines stopped one short of the far end; beta.4 lays the
/// collapsed outer border out as the table's border and paints it there.
#[test]
fn collapsed_cell_borders_ring_the_table_box_on_its_outermost_pixels() {
    for scale in [1.0f32, 2.0] {
        let img = paint_table(
            r#"<table data-mv-id="t" style="border-collapse:collapse;width:100px"><tr><td style="height:20px;border:1px solid #ccc"></td><td style="border:1px solid #ccc"></td></tr></table>"#,
            scale,
        );
        let (x0, y0, x1, y1) = img.rect;
        let b = scale as u32;
        let (mid_x, mid_y) = (x0 + (x1 - x0) / 4, y0 + (y1 - y0) / 2);
        assert!((0..b).all(|d| near(img.px(x1 - b + d, mid_y), CCC)), "scale {scale}: right line on the last column");
        assert!(near(img.px(x1 - b - 1, mid_y), WHITE), "scale {scale}: one line thick on the right");
        assert!((0..b).all(|d| near(img.px(mid_x, y1 - b + d), CCC)), "scale {scale}: bottom line on the last row");
        assert!(near(img.px(mid_x, y1 - b - 1), WHITE), "scale {scale}: one line thick at the bottom");
        assert!(near(img.px(x1 - b, y0), CCC), "scale {scale}: the top line reaches the last column");
        assert!(near(img.px(x0, y1 - b), CCC), "scale {scale}: the left line reaches the last row");
    }
}

/// A table border and cell borders both (`border: 1px solid #ccc` on the table and on its
/// cells) under `border-collapse: collapse` draw one line on every edge, as WKWebView does.
/// blitz-paint beta.2 drew the table's own box border on the box's outermost pixels and the
/// collapsed ring a border inside it, two lines thick on the right and the bottom.
#[test]
fn collapsed_table_and_cell_borders_draw_one_line_per_edge() {
    for scale in [1.0f32, 2.0] {
        let img = paint_table(
            r#"<table data-mv-id="t" style="border-collapse:collapse;width:100px;border:1px solid #ccc"><tr><td style="height:20px;border:1px solid #ccc"></td><td style="border:1px solid #ccc"></td></tr></table>"#,
            scale,
        );
        let (x0, y0, x1, y1) = img.rect;
        let b = scale as u32;
        let (mid_x, mid_y) = (x0 + (x1 - x0) / 4, y0 + (y1 - y0) / 2);
        assert!((0..b).all(|d| near(img.px(x1 - b + d, mid_y), CCC)) && near(img.px(x1 - b - 1, mid_y), WHITE), "scale {scale}: right edge");
        assert!((0..b).all(|d| near(img.px(mid_x, y1 - b + d), CCC)) && near(img.px(mid_x, y1 - b - 1), WHITE), "scale {scale}: bottom edge");
        assert!(near(img.px(x0, mid_y), CCC) && near(img.px(x0 + b, mid_y), WHITE), "scale {scale}: left edge");
        assert!(near(img.px(mid_x, y0), CCC) && near(img.px(mid_x, y0 + b), WHITE), "scale {scale}: top edge");
    }
}

/// KNOWN RESIDUE (blitz-paint, unvendored): the painter takes one width for every outer line,
/// the narrowest used side of the first cell, so the bottom-only borders of a row-separator
/// table give no outer line at all. The last row's bottom separator (CSS 2.1 17.6.2: the
/// border-bottom of the last row is a border of the table's edge) and the three other sides
/// are not drawn. Before the fix this table had a 3px black frame.
#[test]
fn known_residue_row_separators_have_no_outer_lines() {
    for scale in [1.0f32, 2.0] {
        let img = paint_table(ROW_SEPARATORS, scale);
        let (x0, y0, x1, y1) = img.rect;
        let b = scale as u32;
        assert!((x0..x1).all(|x| (0..b).all(|d| near(img.px(x, y1 - b + d), WHITE))), "scale {scale}: no bottom line");
        assert!((x0..x1).all(|x| (0..b).all(|d| near(img.px(x, y0 + d), WHITE))), "scale {scale}: no top line");
        // The first row, above the first separator (which crosses the outer columns).
        let first_row = y0..y0 + 12 * b;
        assert!(first_row.clone().all(|y| (0..b).all(|d| near(img.px(x0 + d, y), WHITE))), "scale {scale}: no left line");
        assert!(first_row.clone().all(|y| (0..b).all(|d| near(img.px(x1 - b + d, y), WHITE))), "scale {scale}: no right line");
    }
}
