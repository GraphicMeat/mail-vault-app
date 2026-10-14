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
