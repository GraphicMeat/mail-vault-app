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
fn a_paragraph_that_straddles_a_tile_boundary_belongs_wholly_to_its_first_lines_tile() {
    // Four 30 px lines from 480: 480 and 510 start in tile 0, 540 and 570 in tile 1.
    // One inline root must be one element in the layer (a triple-click selects the
    // paragraph), so every line goes to the tile of the root's first line.
    let body = r#"<div style="height:480px"></div><p style="margin:0;width:60px">aaaa bbbb cccc dddd</p><p style="margin:0">after</p>"#;
    let doc = open(body);
    let t0 = doc.text_runs(0);
    let t1 = doc.text_runs(1);
    let para: Vec<_> = t0.iter().filter(|r| r.text.trim() != "after").collect();
    assert_eq!(para.iter().map(|r| r.text.as_str()).collect::<String>(), "aaaa bbbb cccc dddd", "{t0:?}");
    assert!(para.iter().any(|r| r.y >= TILE_CSS_HEIGHT as f32), "the later lines are below the boundary: {para:?}");
    assert!(t1.iter().all(|r| r.node != para[0].node), "no line of the paragraph in tile 1: {t1:?}");
    assert_eq!(t1.iter().map(|r| r.text.as_str()).collect::<Vec<_>>(), ["after"]);
    // Tile 1 shows lines of a root owned by tile 0: a lazy layer must load tile 0 too.
    assert_eq!(doc.text_owners(1), [0]);
    assert!(doc.text_owners(0).is_empty());
}

#[test]
fn every_root_of_a_tall_wrapped_doc_appears_in_exactly_one_tile_and_whole() {
    let body: String = (0..120).map(|i| format!("<p style=\"margin:0;width:200px\">para {i} with enough words to wrap twice</p>")).collect();
    let doc = open(&body);
    let tiles = (doc.meta().css_height / TILE_CSS_HEIGHT as f32).ceil() as u32;
    let mut seen: std::collections::HashMap<u64, (u32, String)> = std::collections::HashMap::new();
    let mut straddlers = 0;
    for i in 0..tiles {
        let runs = doc.text_runs(i);
        for r in &runs {
            let e = seen.entry(r.node).or_insert((i, String::new()));
            assert_eq!(e.0, i, "node {} in tiles {} and {i}", r.node, e.0);
            e.1.push_str(&r.text);
        }
        straddlers += runs.iter().filter(|r| (r.y / TILE_CSS_HEIGHT as f32).floor() as u32 != i).count();
    }
    assert_eq!(seen.len(), 120);
    for (i, (_, text)) in seen.values().enumerate() {
        assert!(text.contains(" with enough words to wrap twice"), "{i}: {text:?}");
    }
    assert!(straddlers > 0, "the fixture has lines below their root's tile");
}

#[test]
fn hard_breaks_split_a_root_into_segments_and_offsets_stay_root_relative() {
    let runs = open(r#"<p style="margin:0">one<br>two<br>three</p>"#).text_runs(0);
    assert_eq!(runs.iter().map(|r| r.text.as_str()).collect::<String>(), "one\ntwo\nthree", "{runs:?}");
    assert!(runs.iter().all(|r| r.node == runs[0].node), "one root");
    let segs: Vec<usize> = runs.iter().map(|r| r.seg).collect();
    let mut distinct = segs.clone();
    distinct.dedup();
    assert_eq!(distinct, [0, 4, 8], "a segment starts after each newline: {runs:?}");
    for r in &runs {
        assert!(r.start >= r.seg, "{r:?}");
    }
}

#[test]
fn a_source_newline_in_normal_text_is_not_a_hard_break() {
    let runs = open("<p style=\"margin:0\">one\ntwo</p>").text_runs(0);
    assert!(runs.iter().all(|r| r.seg == 0), "{runs:?}");
}

#[test]
fn a_pre_over_several_tiles_puts_each_hard_line_in_the_tile_of_its_top() {
    // 60 lines of 30 px: 1800 px, tiles 0..=3. One root, 60 segments.
    let text: String = (0..60).map(|i| format!("line {i}\n")).collect();
    let doc = open(&format!("<pre style=\"margin:0;font:inherit\">{text}</pre>"));
    let tiles = (doc.meta().css_height / TILE_CSS_HEIGHT as f32).ceil() as u32;
    assert!(tiles >= 4, "{tiles}");
    let mut all = Vec::new();
    for i in 0..tiles {
        let runs = doc.text_runs(i);
        for r in &runs {
            assert_eq!((r.y / TILE_CSS_HEIGHT as f32).floor() as u32, i, "a one-line segment lives in its own line's tile: {r:?}");
        }
        assert!(doc.text_owners(i).is_empty(), "tile {i}: {:?}", doc.text_owners(i));
        all.extend(runs);
    }
    all.sort_by_key(|r| r.start);
    assert_eq!(all.iter().map(|r| r.text.trim_end_matches('\n')).collect::<Vec<_>>().join("\n") + "\n", text, "every run exactly once");
    assert!(all.iter().all(|r| r.node == all[0].node));
}

#[test]
fn a_segment_over_three_tiles_is_owned_by_its_first_tile_alone() {
    // One unbroken paragraph of about 50 lines of 30 px: 1500 px over tiles 0..=2.
    let words: String = (0..50).map(|i| format!("w{i:03} ")).collect();
    let doc = open(&format!("<p style=\"margin:0;width:60px\">{words}</p>"));
    assert!(doc.meta().css_height > 2.0 * TILE_CSS_HEIGHT as f32, "{}", doc.meta().css_height);
    assert_eq!(doc.text_runs(0).len(), 50);
    for i in 1..3 {
        assert!(doc.text_runs(i).is_empty(), "tile {i}");
        assert_eq!(doc.text_owners(i), [0], "tile {i}");
    }
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

/// The runs of one root partition its text: logical order, no gap, no overlap.
fn assert_partition(runs: &[mailvault_render::text::TextRun], expected: &str) {
    assert_eq!(runs.iter().map(|r| r.text.as_str()).collect::<String>(), expected, "{runs:?}");
    assert_eq!(runs[0].start, 0, "{runs:?}");
    for w in runs.windows(2) {
        assert_eq!(w[0].start + w[0].text.len(), w[1].start, "contiguous, no overlap: {w:?}");
    }
}

fn system_doc(body: &str) -> RenderDoc {
    let html = format!(r#"<body style="margin:0;font:20px/30px sans-serif">{body}</body>"#);
    RenderDoc::open_with(&html, RenderOptions { css_width: 400, scale: 1.0, ..Default::default() }, None, FontLibrary::new(true).context()).unwrap()
}

#[test]
fn rtl_run_split_by_colour_partitions_the_text_with_niqqud() {
    // One shaped RTL run, two glyph runs (same font, different brush).
    let text = "\u{5E9}\u{5C1}\u{5B8}\u{5DC}\u{5D5}\u{5B9}\u{5DD} \u{5E2}\u{5D5}\u{5DC}\u{5DD}";
    let (a, b) = text.split_once(' ').unwrap();
    let runs = system_doc(&format!(r#"<p dir="rtl" style="margin:0">{a} <span style="color:red">{b}</span></p>"#)).text_runs(0);
    assert!(runs.len() >= 2, "{runs:?}");
    assert_partition(&runs, text);
}

#[test]
fn rtl_arabic_harakat_and_lam_alef_split_by_colour_partition_the_text() {
    let text = "\u{645}\u{64E}\u{631}\u{652}\u{62D}\u{628}\u{64B}\u{627} \u{644}\u{627} \u{628}\u{627}\u{644}\u{639}\u{627}\u{644}\u{645}";
    let (a, b) = text.split_at(text.find(' ').unwrap() + 1);
    let runs = system_doc(&format!(r#"<p dir="rtl" style="margin:0">{a}<span style="color:red">{b}</span></p>"#)).text_runs(0);
    assert!(runs.len() >= 2, "{runs:?}");
    assert_partition(&runs, text);
}

#[test]
fn ltr_decomposed_combining_mark_next_to_a_colour_split_keeps_its_base() {
    let text = "cafe\u{301}x";
    let runs = system_doc(r#"<p style="margin:0">cafe&#x301;<span style="color:red">x</span></p>"#).text_runs(0);
    assert!(runs.len() >= 2, "{runs:?}");
    assert_partition(&runs, text);
}

#[test]
fn zwj_family_emoji_next_to_a_colour_split_stays_whole() {
    let text = "a\u{1F469}\u{200D}\u{1F469}\u{200D}\u{1F467}b";
    let runs = system_doc(r#"<p style="margin:0">a&#x1F469;&#x200D;&#x1F469;&#x200D;&#x1F467;<span style="color:red">b</span></p>"#).text_runs(0);
    assert_partition(&runs, text);
}

#[test]
fn root_overflow_hidden_does_not_clip_text_below_the_first_screen() {
    // `overflow` on the root element propagates to the viewport: it is not a clip
    // box of the content, so text far below the window height must still be
    // returned (and blitz lays this document out 3019px tall and paints it all).
    for body_style in ["margin:0", "margin:0;height:100%"] {
        let html = format!(r#"<html style="height:100%;overflow-x:hidden"><body style="{body_style};font:20px/30px 'MV Mono'"><div style="height:3000px"></div><p style="margin:0">far below</p></body></html>"#);
        let doc = RenderDoc::open_with(&html, RenderOptions { css_width: 400, scale: 1.0, ..Default::default() }, None, lib().context()).unwrap();
        let texts: Vec<_> = doc.text_runs(3000 / TILE_CSS_HEIGHT).into_iter().map(|r| r.text).collect();
        assert_eq!(texts, ["far below"], "{body_style}");
    }
}
