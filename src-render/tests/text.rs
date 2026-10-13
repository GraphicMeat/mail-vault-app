use mailvault_render::fonts::{FaceData, FontLibrary};
use mailvault_render::{RenderDoc, RenderOptions, TILE_CSS_HEIGHT};

fn asset(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/../src/assets/fonts/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}
fn lib() -> FontLibrary {
    let mut lib = FontLibrary::new(false);
    lib.register("MV Mono", vec![FaceData { data: asset("ibm-plex-mono-latin-400.woff2"), weight: 400, style: "normal".into() }]);
    lib.register("MV Fira", vec![FaceData { data: asset("fira-code-latin.woff2"), weight: 400, style: "normal".into() }]);
    lib
}
fn open(body: &str) -> RenderDoc {
    let html = format!(r#"<body style="margin:0;font:20px/30px 'MV Mono'">{body}</body>"#);
    RenderDoc::open_with(&html, RenderOptions { css_width: 400, scale: 2.0, ..Default::default() }, None, lib().context()).unwrap()
}

#[test]
fn one_line_run_has_css_px_geometry_at_scale_2() {
    let runs = open(r#"<p style="margin:0;padding:10px 0 0 7px">abc def</p>"#).text_runs(0);
    assert_eq!(runs.len(), 1, "{runs:?}");
    let r = &runs[0];
    assert_eq!(r.text, "abc def");
    assert!((r.x - 7.0).abs() < 0.5 && (r.y - 10.0).abs() < 0.5, "{r:?}");
    assert!((r.w - 84.0).abs() < 0.5, "7 x 12px: {}", r.w);
    assert!((r.h - 30.0).abs() < 0.5);
    assert!((r.font_px - 20.0).abs() < 0.01);
    assert_eq!(r.start, 0);
}

#[test]
fn runs_of_a_root_concatenate_to_its_layout_text_and_keep_the_invariant() {
    let doc = open(r#"<p style="margin:0;width:120px">aaaa bbbb cccc dddd</p>"#);
    let runs = doc.text_runs(0);
    assert!(runs.len() >= 2, "wrapped: {runs:?}");
    let joined: String = runs.iter().map(|r| r.text.as_str()).collect();
    assert_eq!(joined, "aaaa bbbb cccc dddd");
    for w in runs.windows(2) {
        assert_eq!(w[0].start + w[0].text.len(), w[1].start, "contiguous: {w:?}");
    }
}

#[test]
fn style_change_splits_runs_and_link_is_its_own_run() {
    let runs = open(r#"<p style="margin:0">go <a href="https://x.test/">here</a> now</p>"#).text_runs(0);
    let texts: Vec<_> = runs.iter().map(|r| r.text.as_str()).collect();
    assert_eq!(texts.concat(), "go here now");
    assert!(texts.contains(&"here"), "{texts:?}");
}

#[test]
fn straddling_line_belongs_to_one_tile() {
    // Line top at 500: belongs to tile 0 although it ends at 530.
    let body = r#"<div style="height:500px"></div><p style="margin:0">straddle</p><p style="margin:0">next</p>"#;
    let doc = open(body);
    let t0: Vec<_> = doc.text_runs(0).into_iter().map(|r| r.text).collect();
    let t1: Vec<_> = doc.text_runs(1).into_iter().map(|r| r.text).collect();
    assert!(t0.contains(&"straddle".to_string()), "{t0:?}");
    assert!(!t1.contains(&"straddle".to_string()), "{t1:?}");
    assert!(t1.contains(&"next".to_string()), "530 / {TILE_CSS_HEIGHT} = tile 1: {t1:?}");
}

#[test]
fn noselect_runs_are_dropped() {
    let runs = open(r#"<p style="margin:0">Hi <span class="mv-pii" data-mv-noselect>••••</span> there</p><div data-mv-noselect style="display:inline-block">⋯</div>"#).text_runs(0);
    let text: String = runs.iter().map(|r| r.text.as_str()).collect();
    assert!(!text.contains('•') && !text.contains('⋯'), "{text:?}");
    assert!(text.contains("Hi ") && text.contains(" there"));
}

#[test]
fn hidden_clipped_and_zero_size_text_is_dropped() {
    let runs = open(r#"
      <div style="max-height:0;overflow:hidden">preheader</div>
      <p style="margin:0;visibility:hidden">invisible</p>
      <p style="margin:0;font-size:0">zero</p>
      <p style="margin:0">shown</p>"#).text_runs(0);
    let texts: Vec<_> = runs.iter().map(|r| r.text.trim()).collect();
    assert_eq!(texts, ["shown"]);
}

#[test]
fn rtl_runs_are_logical_order_and_visual_x() {
    // System fonts are needed for Hebrew; this test uses them and asserts only relations.
    let html = r#"<body style="margin:0"><p dir="rtl" style="margin:0;font:20px/30px sans-serif;width:300px">שלום abc עולם</p></body>"#;
    let doc = RenderDoc::open_with(html, RenderOptions { css_width: 400, scale: 1.0, ..Default::default() }, None, FontLibrary::new(true).context()).unwrap();
    let runs = doc.text_runs(0);
    assert!(runs.len() >= 2, "{runs:?}");
    for w in runs.windows(2) {
        assert!(w[0].start < w[1].start, "logical order");
    }
    let first = &runs[0];
    let last = runs.last().unwrap();
    assert!(first.text.starts_with('ש'));
    assert!(first.x > last.x, "the first logical run sits to the right in RTL");
}

#[test]
fn ligature_run_keeps_every_char() {
    let html = r#"<body style="margin:0"><p style="margin:0;font:20px/30px 'MV Fira'">a->b</p></body>"#;
    let doc = RenderDoc::open_with(html, RenderOptions { css_width: 400, scale: 1.0, ..Default::default() }, None, lib().context()).unwrap();
    let runs = doc.text_runs(0);
    assert_eq!(runs.iter().map(|r| r.text.as_str()).collect::<String>(), "a->b");
    let w: f32 = runs.iter().map(|r| r.w).sum();
    assert!((w - 4.0 * 12.0).abs() < 0.5, "Fira Code ligatures keep the monospace width: {w}");
}

#[test]
fn emoji_and_cjk_runs_keep_byte_offsets() {
    let html = r#"<body style="margin:0"><p style="margin:0;font:20px/30px sans-serif">naïve 😀 東京</p></body>"#;
    let doc = RenderDoc::open_with(html, RenderOptions { css_width: 400, scale: 1.0, ..Default::default() }, None, FontLibrary::new(true).context()).unwrap();
    let runs = doc.text_runs(0);
    assert_eq!(runs.iter().map(|r| r.text.as_str()).collect::<String>(), "naïve 😀 東京");
    for w in runs.windows(2) {
        assert_eq!(w[0].start + w[0].text.len(), w[1].start, "byte-contiguous across font changes");
    }
}

#[test]
fn every_tile_of_a_tall_doc_within_the_textruns_budget() {
    let body: String = (0..400).map(|i| format!("<p style=\"margin:0\">line {i} with some words</p>")).collect();
    let doc = open(&body); // 400 x 30 px: 24 tiles
    let tiles = (doc.meta().css_height / TILE_CSS_HEIGHT as f32).ceil() as u32;
    let t0 = std::time::Instant::now();
    let total: usize = (0..tiles).map(|i| doc.text_runs(i).len()).sum();
    assert_eq!(total, 400, "each line once");
    assert!(t0.elapsed() < std::time::Duration::from_secs(4), "{:?} for {tiles} tiles", t0.elapsed());
}

#[test]
fn inline_block_and_table_cells_are_their_own_roots_in_document_order() {
    let runs = open(r#"<table style="border-collapse:collapse"><tr><td>one</td><td>two</td></tr><tr><td>three</td><td><span style="display:inline-block">four</span></td></tr></table>"#).text_runs(0);
    let texts: Vec<_> = runs.iter().map(|r| r.text.as_str()).collect();
    assert_eq!(texts, ["one", "two", "three", "four"]);
}
