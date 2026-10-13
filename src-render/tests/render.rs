use mailvault_render::{OpenError, RenderDoc, RenderOptions, MAX_HTML_BYTES, TILE_CSS_HEIGHT};

fn fx(name: &str) -> String {
    std::fs::read_to_string(format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}
fn open(html: &str, w: u32) -> RenderDoc {
    RenderDoc::open(html, RenderOptions::new(w, 1.0), None).unwrap()
}
fn png_size(png: &[u8]) -> (u32, u32) {
    let d = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
    (d.info().width, d.info().height)
}

#[test]
fn tall_doc_reports_height_and_tile_count() {
    let doc = open(&fx("tall.html"), 600);
    let m = doc.meta();
    assert!((m.css_height - 1300.0).abs() < 1.0, "height {}", m.css_height);
    assert_eq!(m.tile_css_height, TILE_CSS_HEIGHT);
    assert_eq!(m.tile_count, 3); // 1300 / 512 rounded up
}

#[test]
fn tile_is_png_at_device_pixels_and_last_tile_is_shorter() {
    let mut doc = RenderDoc::open(&fx("tall.html"), RenderOptions::new(600, 2.0), None).unwrap();
    assert_eq!(png_size(&doc.tile_png(0).unwrap()), (1200, 1024));
    assert_eq!(png_size(&doc.tile_png(2).unwrap()), (1200, ((1300 - 1024) * 2) as u32));
}

#[test]
fn tile_paints_content_not_blank() {
    let mut doc = open(&fx("tall.html"), 600);
    let png = doc.tile_png(0).unwrap();
    let mut r = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
    let mut buf = vec![0; r.output_buffer_size()];
    r.next_frame(&mut buf).unwrap();
    // RGB output: the first pixel is the red div.
    assert_eq!(&buf[0..3], &[255, 0, 0]);
}

#[test]
fn wide_content_widens_meta_width() {
    let m = open(&fx("wide.html"), 600).meta();
    assert!(m.css_width >= 900.0, "width {}", m.css_width);
}

#[test]
fn hit_block_link_carries_alert_and_title() {
    let doc = open(&fx("links.html"), 600);
    let l = doc.hit_link(10.0, 10.0).expect("block link");
    assert_eq!(l.href, "https://example.com/block");
    assert_eq!(l.alert.as_deref(), Some("yellow"));
    assert_eq!(l.title.as_deref(), Some("Looks off"));
}

#[test]
fn hit_inline_link_resolves_through_text() {
    let doc = open(&fx("links.html"), 600);
    // The second line is the <p>: y 60..108. "Go " is about 60px, the link follows.
    let l = doc.hit_link(150.0, 84.0).expect("inline link");
    assert_eq!(l.href, "https://example.com/inline");
}

#[test]
fn hit_far_down_the_document() {
    let doc = open(&fx("links.html"), 600);
    let y = 60.0 + 48.0 + 1200.0 + 10.0;
    assert_eq!(doc.hit_link(10.0, y).unwrap().href, "mailto:a@example.com");
}

#[test]
fn hit_on_background_is_none() {
    let doc = open(&fx("links.html"), 600);
    assert!(doc.hit_link(500.0, 30.0).is_none());
}

#[test]
fn hit_after_reopen_at_new_width() {
    let html = r#"<body style="margin:0"><div style="width:50%;height:40px"></div><a href="https://x.test/" style="display:block;height:40px">x</a></body>"#;
    let narrow = open(html, 400);
    assert_eq!(narrow.hit_link(10.0, 50.0).unwrap().href, "https://x.test/");
    let wide = open(html, 1000);
    assert_eq!(wide.hit_link(10.0, 50.0).unwrap().href, "https://x.test/");
}

#[test]
fn meta_lists_links_and_plain_text() {
    let m = open(&fx("links.html"), 600).meta();
    let hrefs: Vec<_> = m.links.iter().map(|l| l.href.as_str()).collect();
    assert_eq!(hrefs, ["https://example.com/block", "https://example.com/inline", "mailto:a@example.com"]);
    assert!(m.plain_text.contains("inlinelinkinline"));
}

#[test]
fn oversize_html_is_refused() {
    let html = "a".repeat(MAX_HTML_BYTES + 1);
    let err = RenderDoc::open(&html, RenderOptions::new(600, 1.0), None).err().unwrap();
    assert!(matches!(err, OpenError::TooLarge));
    assert_eq!(err.code(), "render_too_large");
}

#[test]
fn node_bomb_is_refused() {
    let html = format!("<table>{}</table>", "<tr><td>x</td></tr>".repeat(60_000));
    let err = RenderDoc::open(&html, RenderOptions::new(600, 1.0), None).err().unwrap();
    assert!(matches!(err, OpenError::TooComplex));
}

#[test]
fn absurd_height_is_clamped() {
    let html = r#"<body style="margin:0"><div style="height:900000px"></div></body>"#;
    let m = open(html, 600).meta();
    assert!(m.css_height <= mailvault_render::MAX_CSS_HEIGHT);
}

fn rgb_pixels(png: &[u8]) -> (u32, u32, Vec<u8>) {
    let mut r = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
    let mut buf = vec![0; r.output_buffer_size()];
    let info = r.next_frame(&mut buf).unwrap();
    (info.width, info.height, buf)
}
fn px(img: &(u32, u32, Vec<u8>), x: u32, y: u32) -> [u8; 3] {
    let i = ((y * img.0 + x) * 3) as usize;
    [img.2[i], img.2[i + 1], img.2[i + 2]]
}

fn assert_bands(scale: f32) {
    let mut doc = RenderDoc::open(&fx("bands.html"), RenderOptions::new(600, scale), None).unwrap();
    assert_eq!(doc.meta().tile_count, 3);
    let tile_h = (512.0 * scale) as u32;
    let colours = [[255, 0, 0], [0, 0, 255], [0, 0xaa, 0]];
    for (i, want) in colours.iter().enumerate() {
        let img = rgb_pixels(&doc.tile_png(i as u32).unwrap());
        assert_eq!(img.1, tile_h, "tile {i} height");
        assert_eq!(&px(&img, 0, 0), want, "tile {i} first row");
        assert_eq!(&px(&img, img.0 / 2, tile_h / 2), want, "tile {i} middle");
        assert_eq!(&px(&img, 0, tile_h - 1), want, "tile {i} last row");
    }
}

#[test]
fn each_tile_paints_its_own_slice_of_the_document() {
    assert_bands(1.0);
}

#[test]
fn each_tile_paints_its_own_slice_at_scale_2() {
    assert_bands(2.0);
}

// ---- Fix A, theme 1: relative URLs resolve against an unresolvable base ----

fn paints(html: &str) -> Vec<mailvault_render::net::FetchRequest> {
    use mailvault_render::net::BridgeNet;
    let net = BridgeNet::new(true);
    let mut doc = RenderDoc::open(html, RenderOptions::new(300, 1.0), Some(net.clone()))
        .unwrap_or_else(|_| panic!("open failed for {html}"));
    doc.apply_resources();
    let png = doc.tile_png(0).unwrap();
    assert_eq!(&png[1..4], b"PNG", "tile renders for {html}");
    net.take_outbox()
}

#[test]
fn relative_and_odd_urls_neither_panic_nor_fetch() {
    let bodies = [
        r#"<img src="logo.png">ok"#,
        r#"<img src=" ">ok"#,
        r#"<img src="//cdn.example/x.png">ok"#,
        r#"<img src="/abs/path.png">ok"#,
        r#"<link rel="stylesheet" href="rel.css"><p>ok"#,
        r#"<style>body{background:url(rel.png)}</style><p>ok"#,
        r#"<style>@import "x.css"; p{color:red}</style><p>ok"#,
        r#"<style>@font-face{font-family:f;src:url(rel.woff2)}</style><p style="font-family:f">ok"#,
        r#"<p style="background:url(rel.png)">ok"#,
    ];
    for body in bodies {
        let out = paints(body);
        assert!(out.is_empty(), "{body} queued {out:?}");
    }
}
