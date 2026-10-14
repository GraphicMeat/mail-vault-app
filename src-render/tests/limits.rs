//! Hostile-input probes: widths, buffers and markup that must be refused or
//! clamped, never allowed to panic or balloon.
use mailvault_render::{tile_dims, OpenError, RenderDoc, RenderOptions, TileError, MAX_CSS_WIDTH, MAX_NODES, MAX_TILE_PIXELS, TILE_CSS_HEIGHT};
use std::time::{Duration, Instant};

const MAX_W: f32 = MAX_CSS_WIDTH;

fn png_size(png: &[u8]) -> (u32, u32) {
    let d = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
    (d.info().width, d.info().height)
}

#[test]
fn forty_thousand_px_wide_content_is_clamped_at_scale_2() {
    let html = r#"<body style="margin:0"><div style="width:40000px;height:10px;background:#f00"></div></body>"#;
    let mut doc = RenderDoc::open(html, RenderOptions::new(600, 2.0), None).unwrap();
    let m = doc.meta();
    assert!(m.css_width <= MAX_W, "meta width {}", m.css_width);
    let (w, _) = png_size(&doc.tile_png(0).unwrap());
    assert!(w as f32 <= MAX_W * 2.0, "tile width {w}");
}

#[test]
fn a_huge_requested_width_is_clamped_by_the_engine_itself() {
    let mut doc = RenderDoc::open("<p>x", RenderOptions::new(1_000_000, 1.0), None).unwrap();
    assert!(doc.meta().css_width <= MAX_W);
    let (w, _) = png_size(&doc.tile_png(0).unwrap());
    assert!(w as f32 <= MAX_W);
}

#[test]
fn four_mib_of_br_is_refused_before_parsing() {
    let html = "<br>".repeat(1 << 20);
    assert_eq!(html.len(), 4 * 1024 * 1024);
    let t = Instant::now();
    let err = RenderDoc::open(&html, RenderOptions::new(600, 1.0), None).err().unwrap();
    assert!(matches!(err, OpenError::TooComplex));
    assert!(t.elapsed() < Duration::from_secs(3), "refusal took {:?}", t.elapsed());
}

#[test]
fn a_node_count_just_over_the_limit_is_still_refused_after_parsing() {
    // 160k nodes from 160k '<' bytes: under the 2 * MAX_NODES pre-parse bound,
    // over MAX_NODES once parsed.
    let html = "<br>".repeat(MAX_NODES + 10_000);
    let err = RenderDoc::open(&html, RenderOptions::new(600, 1.0), None).err().unwrap();
    assert!(matches!(err, OpenError::TooComplex));
}

#[test]
fn an_absurd_scale_is_clamped_by_the_engine_itself() {
    let mut doc = RenderDoc::open("<p>x", RenderOptions::new(600, 100.0), None).unwrap();
    let (w, h) = png_size(&doc.tile_png(0).unwrap());
    assert_eq!(w, 2400, "scale 4 is the ceiling");
    assert!(h <= TILE_CSS_HEIGHT * 4);
}

#[test]
fn a_tile_index_past_the_end_is_an_error_not_a_blank_image() {
    let mut doc = RenderDoc::open("<p>x", RenderOptions::new(300, 1.0), None).unwrap();
    assert_eq!(doc.meta().tile_count, 1);
    assert_eq!(doc.tile_png(1).unwrap_err(), TileError::OutOfRange);
    assert_eq!(TileError::OutOfRange.code(), "render_tile_failed");
}

#[test]
fn tile_size_math_is_bounded_and_cannot_wrap() {
    // The widest, sharpest legal tile fits the cap...
    assert!(MAX_CSS_WIDTH as u64 * 4 * (TILE_CSS_HEIGHT as u64 * 4) <= MAX_TILE_PIXELS);
    assert_eq!(tile_dims(MAX_CSS_WIDTH, 100_000.0, 0, 4.0), Ok((16_000, 2048)));
    // ...the worst case buffer is bounded by the constant...
    assert!(MAX_TILE_PIXELS * 4 <= 160 * 1024 * 1024);
    // ...and nothing above it, however absurd, is allowed through or wraps.
    assert_eq!(tile_dims(100_000.0, 600.0, 0, 4.0), Err(TileError::TooLarge));
    assert_eq!(tile_dims(f32::MAX, f32::MAX, 0, f32::MAX), Err(TileError::TooLarge));
    assert_eq!(tile_dims(f32::NAN, 600.0, 0, 1.0), Err(TileError::TooLarge));
    assert_eq!(TileError::TooLarge.code(), "render_too_large");
    assert_eq!(tile_dims(600.0, 600.0, 1, 1.0), Ok((600, 88)), "last tile is shorter");
}

#[test]
fn a_nesting_bomb_is_refused_before_the_parser_sees_it() {
    // 100 000 nested divs took many minutes to parse; the pre-parse guard makes it instant.
    let html = "<div>".repeat(100_000);
    let t = Instant::now();
    assert!(matches!(RenderDoc::open(&html, RenderOptions::new(600, 1.0), None).err().unwrap(), OpenError::TooComplex));
    assert!(t.elapsed() < Duration::from_secs(3), "refusal took {:?}", t.elapsed());
    let mixed = "<TABLE><span><Div>".repeat(100);
    assert!(matches!(RenderDoc::open(&mixed, RenderOptions::new(600, 1.0), None).err().unwrap(), OpenError::TooComplex));
}

#[test]
fn ordinary_wide_and_long_markup_is_not_mistaken_for_a_bomb() {
    // Siblings, balanced pairs and unclosed implied-end elements never count as depth.
    let siblings = "<div>x</div><span>y</span>".repeat(5_000);
    RenderDoc::open(&siblings, RenderOptions::new(600, 1.0), None).unwrap();
    let paragraphs = "<p>unclosed paragraph ".repeat(2_000);
    RenderDoc::open(&paragraphs, RenderOptions::new(600, 1.0), None).unwrap();
    let nested_100 = format!("{}x{}", "<div>".repeat(100), "</div>".repeat(100));
    RenderDoc::open(&nested_100, RenderOptions::new(600, 1.0), None).unwrap();
}

#[test]
fn colspan_zero_and_huge_spans_are_clamped_not_overflowed() {
    // HTML: colspan 0 is 1, above 1000 is 1000; rowspan above 65534 is 65534.
    for html in [
        r#"<table cellspacing="2"><tr><td colspan="0">a</td><td>b</td></tr></table>"#,
        r#"<table><tr><td colspan="40000">a</td><td colspan="40000">b</td></tr><tr><td>c</td></tr></table>"#,
        r#"<table><tr><td rowspan="70000">a</td><td>b</td></tr></table>"#,
    ] {
        let mut doc = RenderDoc::open(html, RenderOptions::new(600, 1.0), None).unwrap();
        doc.tile_png(0).unwrap();
    }
}

#[test]
fn a_huge_font_size_attribute_saturates() {
    for size in ["+2147483647", "-2147483648", "99999999999999999999"] {
        let html = format!(r#"<font size="{size}">x</font>"#);
        let mut doc = RenderDoc::open(&html, RenderOptions::new(600, 1.0), None).unwrap();
        doc.tile_png(0).unwrap();
    }
}

#[test]
fn a_font_face_cannot_inject_declarations() {
    // U+000C is a CSS newline: it ended the quoted family early and `color:red` landed in
    // the element's presentational hints.
    let html = "<font face=\"a&#12;;color:red;x:\" data-mv-id=\"f\">x</font>";
    let els = RenderDoc::open(html, RenderOptions::new(600, 1.0), None).unwrap().inspect();
    let f = els.iter().find(|e| e.mv_id == "f").unwrap();
    assert_eq!(f.color, Some([0.0, 0.0, 0.0, 1.0]));
}
