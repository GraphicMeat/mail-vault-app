//! SVG paints (inline, `data:` in `<img>` and CSS, fetched `image/svg+xml`),
//! but it is the one document format inside the worker that can name resources
//! itself: usvg's default href resolver reads any non-`data:` image href as a
//! local file path. A hostile mail must not make the worker read a file or
//! fetch a url, so the vendored blitz-dom installs a resolver that refuses every
//! non-`data:` href and caps nested rasters (`parse_svg_image`), and inline
//! `<svg>` `<image>` elements that name anything but a `data:` url are stripped
//! before layout as a second line. gzip (svgz) bytes never leave `BridgeNet`.
use base64::Engine;
use mailvault_render::net::BridgeNet;
use mailvault_render::{RenderDoc, RenderOptions};
use std::path::PathBuf;

const WHITE: [u8; 3] = [255, 255, 255];
const RED: [u8; 3] = [255, 0, 0];

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn encode_png(w: u32, h: u32, color: png::ColorType, depth: png::BitDepth, palette: Option<Vec<u8>>, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut enc = png::Encoder::new(&mut out, w, h);
    enc.set_color(color);
    enc.set_depth(depth);
    if let Some(p) = palette {
        enc.set_palette(p);
    }
    enc.write_header().unwrap().write_image_data(data).unwrap();
    out
}

fn red_png_4x4() -> Vec<u8> {
    encode_png(4, 4, png::ColorType::Rgb, png::BitDepth::Eight, None, &[255, 0, 0].repeat(16))
}

/// A genuine 5000 x 5000 (25 Mpx, over MAX_IMAGE_PIXELS) all-red PNG, 1 bit per pixel.
fn red_png_25_megapixels() -> Vec<u8> {
    let row = 5000usize.div_ceil(8);
    encode_png(5000, 5000, png::ColorType::Indexed, png::BitDepth::One, Some(vec![255, 0, 0, 255, 0, 0]), &vec![0u8; row * 5000])
}

/// A red PNG on disk that only a file read can reach. Deleted on drop.
struct SecretFile(PathBuf);
impl SecretFile {
    fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!("mv-render-svg-{}-{tag}.png", std::process::id()));
        std::fs::write(&path, red_png_4x4()).unwrap();
        SecretFile(path)
    }
    fn href(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}
impl Drop for SecretFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn svg_with_image(href: &str) -> String {
    format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><image href="{href}" x="0" y="0" width="100" height="100"/></svg>"#)
}

fn rgb_at(png: &[u8], x: u32, y: u32) -> [u8; 3] {
    let mut r = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
    let mut buf = vec![0; r.output_buffer_size()];
    let info = r.next_frame(&mut buf).unwrap();
    let i = ((y * info.width + x) * 3) as usize;
    [buf[i], buf[i + 1], buf[i + 2]]
}

/// Open `html` with a remote-enabled net, render tile 0, return the pixel at (50, 50).
fn probe(html: &str) -> [u8; 3] {
    let net = BridgeNet::new(true);
    let mut doc = RenderDoc::open(html, RenderOptions::new(200, 1.0), Some(net)).unwrap();
    doc.apply_resources();
    rgb_at(&doc.tile_png(0).unwrap(), 50, 50)
}

/// Like `probe`, at several points, and also returns how many fetches the net was asked for.
fn probe_pts(html: &str, pts: &[(u32, u32)]) -> (Vec<[u8; 3]>, usize) {
    let net = BridgeNet::new(true);
    let mut doc = RenderDoc::open(html, RenderOptions::new(200, 1.0), Some(net.clone())).unwrap();
    doc.apply_resources();
    let png = doc.tile_png(0).unwrap();
    (pts.iter().map(|&(x, y)| rgb_at(&png, x, y)).collect(), net.take_outbox().len())
}

fn body(inner: &str) -> String {
    format!(r#"<body style="margin:0">{inner}</body>"#)
}

// ---- the three routes to a local file ----

#[test]
fn inline_svg_image_cannot_read_a_local_file() {
    let secret = SecretFile::new("inline");
    assert_eq!(probe(&body(&svg_with_image(&secret.href()))), WHITE, "the file was drawn into the mail");
}

#[test]
fn a_data_svg_in_img_cannot_read_a_local_file() {
    let secret = SecretFile::new("img");
    let src = format!("data:image/svg+xml;base64,{}", b64(svg_with_image(&secret.href()).as_bytes()));
    assert_eq!(probe(&body(&format!(r#"<img src="{src}" width="100" height="100">"#))), WHITE, "the file was drawn into the mail");
}

#[test]
fn a_data_svg_in_css_url_cannot_read_a_local_file() {
    let secret = SecretFile::new("css");
    let url = format!("data:image/svg+xml;base64,{}", b64(svg_with_image(&secret.href()).as_bytes()));
    let div = format!(r#"<div style="width:100px;height:100px;background-image:url('{url}')"></div>"#);
    assert_eq!(probe(&body(&div)), WHITE, "the file was drawn into the mail");
}

// ---- the pixel-cap bypass ----

#[test]
fn an_inline_svg_cannot_smuggle_a_25_megapixel_data_png() {
    let svg = svg_with_image(&format!("data:image/png;base64,{}", b64(&red_png_25_megapixels())));
    assert_eq!(probe(&body(&svg)), WHITE, "a 25 Mpx raster was decoded and drawn");
}

// ---- bytes that usvg would parse ----

fn crc32(data: &[u8]) -> u32 {
    let mut c = !0u32;
    for &b in data {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 == 1 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
        }
    }
    !c
}

/// A valid gzip stream holding `data` in one stored deflate block (data < 64 KiB).
fn gzip(data: &[u8]) -> Vec<u8> {
    let len = data.len() as u16;
    let mut out = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255, 1];
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&(!len).to_le_bytes());
    out.extend_from_slice(data);
    out.extend_from_slice(&crc32(data).to_le_bytes());
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out
}

const RED_RECT_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#f00"/></svg>"##;

/// Fetch `bytes` as the daemon's answer to `<img src="https://i.test/x">` and probe the result.
fn probe_fetched(bytes: Vec<u8>) -> [u8; 3] {
    let net = BridgeNet::new(true);
    let html = body(r#"<img src="https://i.test/x" width="100" height="100">"#);
    let mut doc = RenderDoc::open(&html, RenderOptions::new(200, 1.0), Some(net.clone())).unwrap();
    let id = net.take_outbox().first().expect("the image was queued").id;
    assert!(net.complete(id, Some(bytes)));
    doc.apply_resources();
    let px = rgb_at(&doc.tile_png(0).unwrap(), 50, 50);
    assert!(net.take_outbox().is_empty(), "the SVG made the worker ask for another resource");
    px
}

#[test]
fn fetched_svg_bytes_paint() {
    assert_eq!(probe_fetched(RED_RECT_SVG.as_bytes().to_vec()), RED);
}

#[test]
fn svg_behind_a_prolog_comment_bom_or_prefix_paints() {
    let variants = [
        format!("<?xml version=\"1.0\"?>\n{RED_RECT_SVG}"),
        format!("<!-- hi -->{RED_RECT_SVG}"),
        format!("\u{feff}  \n\t{RED_RECT_SVG}"),
        r##"<s:svg xmlns:s="http://www.w3.org/2000/svg" width="100" height="100"><s:rect width="100" height="100" fill="#f00"/></s:svg>"##.to_string(),
    ];
    for v in variants {
        assert_eq!(probe_fetched(v.clone().into_bytes()), RED, "SVG did not paint: {v}");
    }
}

#[test]
fn gzip_bytes_are_refused_because_usvg_inflates_svgz() {
    assert_eq!(probe_fetched(gzip(RED_RECT_SVG.as_bytes())), WHITE, "svgz reached usvg");
}

#[test]
fn a_fetched_svg_cannot_read_a_local_file() {
    let secret = SecretFile::new("fetched");
    assert_eq!(probe_fetched(svg_with_image(&secret.href()).into_bytes()), WHITE, "the file was drawn into the mail");
}

// ---- SVG paints from every source ----

#[test]
fn a_data_svg_in_img_paints() {
    let src = format!("data:image/svg+xml;base64,{}", b64(RED_RECT_SVG.as_bytes()));
    assert_eq!(probe(&body(&format!(r#"<img src="{src}" width="100" height="100">"#))), RED);
}

#[test]
fn a_data_svg_in_css_url_paints() {
    let url = format!("data:image/svg+xml;base64,{}", b64(RED_RECT_SVG.as_bytes()));
    let div = format!(r#"<div style="width:100px;height:100px;background-image:url('{url}')"></div>"#);
    assert_eq!(probe(&body(&div)), RED);
}

#[test]
fn a_percent_encoded_data_svg_paints() {
    let src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect width='100' height='100' fill='red'/%3E%3C/svg%3E";
    assert_eq!(probe(&body(&format!(r#"<img src="{src}" width="100" height="100">"#))), RED);
}

// ---- nested data: rasters are allowed, and capped ----

fn red_data_png_4x4() -> String {
    format!("data:image/png;base64,{}", b64(&red_png_4x4()))
}

#[test]
fn an_inline_svg_image_with_a_data_png_paints() {
    assert_eq!(probe(&body(&svg_with_image(&red_data_png_4x4()))), RED);
}

#[test]
fn a_data_svg_image_with_a_data_png_paints() {
    let src = format!("data:image/svg+xml;base64,{}", b64(svg_with_image(&red_data_png_4x4()).as_bytes()));
    assert_eq!(probe(&body(&format!(r#"<img src="{src}" width="100" height="100">"#))), RED);
}

#[test]
fn a_data_svg_cannot_smuggle_a_25_megapixel_data_png() {
    let svg = svg_with_image(&format!("data:image/png;base64,{}", b64(&red_png_25_megapixels())));
    let src = format!("data:image/svg+xml;base64,{}", b64(svg.as_bytes()));
    assert_eq!(probe(&body(&format!(r#"<img src="{src}" width="100" height="100">"#))), WHITE, "a 25 Mpx raster was decoded and drawn");
}

/// A 2000 x 2000 (4 Mpx, under the per-image cap) all-red PNG.
fn red_png_4_megapixels() -> Vec<u8> {
    let row = 2000usize.div_ceil(8);
    encode_png(2000, 2000, png::ColorType::Indexed, png::BitDepth::One, Some(vec![255, 0, 0, 255, 0, 0]), &vec![0u8; row * 2000])
}

#[test]
fn one_svg_cannot_decode_more_than_the_image_budget_in_total() {
    // Five 4 Mpx images side by side: each is under the per-image cap, but together they pass
    // the 16 Mpx an SVG may decode, so the fifth is refused.
    let png = format!("data:image/png;base64,{}", b64(&red_png_4_megapixels()));
    let images: String = (0..5).map(|i| format!(r#"<image href="{png}" x="{}" y="0" width="40" height="100"/>"#, i * 40)).collect();
    let svg = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">{images}</svg>"#);
    let src = format!("data:image/svg+xml;base64,{}", b64(svg.as_bytes()));
    let (px, _) = probe_pts(&body(&format!(r#"<img src="{src}" width="200" height="100">"#)), &[(20, 50), (60, 50), (100, 50), (140, 50), (180, 50)]);
    assert_eq!(&px[..4], &[RED; 4], "the first four images fit the budget");
    assert_eq!(px[4], WHITE, "the fifth image passed the budget");
}

// ---- nothing in an SVG can fetch a url or open a nested SVG ----

/// Every kind of href an SVG could use to name a resource that is not a `data:` image.
fn hostile_svgs() -> Vec<(&'static str, String)> {
    let wrap = |inner: &str| format!(r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="100">{inner}</svg>"#);
    vec![
        ("image file path", wrap(r#"<image href="/etc/passwd" width="100" height="100"/>"#)),
        ("image file url", wrap(r#"<image href="file:///etc/hostname" width="100" height="100"/>"#)),
        ("image http", wrap(r#"<image href="http://i.test/x.png" width="100" height="100"/>"#)),
        ("image https", wrap(r#"<image href="https://i.test/x.png" width="100" height="100"/>"#)),
        ("image scheme-relative", wrap(r#"<image href="//i.test/x.png" width="100" height="100"/>"#)),
        ("image xlink:href", wrap(r#"<image xlink:href="https://i.test/x.png" width="100" height="100"/>"#)),
        ("feImage https", wrap(r#"<filter id="f"><feImage href="https://i.test/x.png"/></filter><rect width="100" height="100" filter="url(#f)"/>"#)),
        ("use external", wrap(r#"<use href="https://i.test/x.svg#a" width="100" height="100"/>"#)),
        ("use xlink external", wrap(r#"<use xlink:href="http://i.test/x.svg#a"/>"#)),
        ("nested svg data in image", wrap(&format!(r#"<image href="data:image/svg+xml;base64,{}" width="100" height="100"/>"#, b64(RED_RECT_SVG.as_bytes())))),
        ("nested svg as text/plain data", wrap(&format!(r#"<image href="data:text/plain;base64,{}" width="100" height="100"/>"#, b64(RED_RECT_SVG.as_bytes())))),
    ]
}

#[test]
fn an_svg_cannot_name_a_url_or_file_from_any_source() {
    for (name, svg) in hostile_svgs() {
        let data = format!("data:image/svg+xml;base64,{}", b64(svg.as_bytes()));
        let css = format!(r#"<div style="width:100px;height:100px;background-image:url('{data}')"></div>"#);
        let routes = [
            ("inline", body(&svg)),
            ("img", body(&format!(r#"<img src="{data}" width="100" height="100">"#))),
            ("css", body(&css)),
        ];
        for (route, html) in routes {
            let (px, requests) = probe_pts(&html, &[(50, 50)]);
            assert_eq!(requests, 0, "{name} via {route}: the worker was asked to fetch something");
            // A filter whose feImage found nothing may still flood its region; it must not be the resource.
            let ok = if name == "feImage https" { px[0] != RED } else { px[0] == WHITE };
            assert!(ok, "{name} via {route}: something was drawn: {:?}", px[0]);
        }
        let fetched = probe_fetched(svg.clone().into_bytes());
        let ok = if name == "feImage https" { fetched != RED } else { fetched == WHITE };
        assert!(ok, "{name} via a fetched svg: something was drawn: {fetched:?}");
    }
}

// ---- we did not break SVG altogether ----

#[test]
fn a_plain_inline_svg_still_renders() {
    assert_eq!(probe(&body(RED_RECT_SVG)), RED);
}

#[test]
fn an_inline_svg_keeps_its_in_document_references() {
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#f00"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/></svg>"##;
    assert_eq!(probe(&body(svg)), RED);
}

#[test]
fn a_real_png_fetch_still_draws() {
    let net = BridgeNet::new(true);
    let html = body(r#"<img src="https://i.test/x.png" width="100" height="100">"#);
    let mut doc = RenderDoc::open(&html, RenderOptions::new(200, 1.0), Some(net.clone())).unwrap();
    let id = net.take_outbox().first().expect("queued").id;
    assert!(net.complete(id, Some(red_png_4x4())));
    doc.apply_resources();
    assert_eq!(rgb_at(&doc.tile_png(0).unwrap(), 50, 50), RED);
}

// ---- XML entities: no DTD expansion in any SVG ----

/// An SVG whose red rectangle exists only through an internal-subset entity.
fn entity_svg() -> String {
    r##"<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY r '<rect width="100" height="100" fill="#f00"/>'>]><svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">&r;</svg>"##.to_string()
}

#[test]
fn an_svg_entity_is_never_expanded_from_any_source() {
    let data = format!("data:image/svg+xml;base64,{}", b64(entity_svg().as_bytes()));
    let css = format!(r#"<div style="width:100px;height:100px;background-image:url('{data}')"></div>"#);
    assert_eq!(probe(&body(&format!(r#"<img src="{data}" width="100" height="100">"#))), WHITE, "img: the entity was expanded");
    assert_eq!(probe(&body(&css)), WHITE, "css: the entity was expanded");
    assert_eq!(probe_fetched(entity_svg().into_bytes()), WHITE, "fetched: the entity was expanded");
}

#[test]
fn an_entity_bomb_is_refused_quickly() {
    // 2000 references to a 50 KB entity that draws a red rectangle: 100 MB once expanded (a
    // mail can ask for gigabytes). Expanded it paints red, so only a refusal is white.
    let svg = format!(
        r##"<!DOCTYPE svg [<!ENTITY a '<rect width="100" height="100" fill="#f00"/><!--{}-->'>]><svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">{}</svg>"##,
        "x".repeat(50_000),
        "&a;".repeat(2000)
    );
    let t = std::time::Instant::now();
    assert_eq!(probe_fetched(svg.into_bytes()), WHITE, "the entity bomb was expanded");
    assert!(t.elapsed() < std::time::Duration::from_secs(5), "took {:?}", t.elapsed());
}

#[test]
fn an_svg_with_a_public_doctype_still_paints() {
    let svg = format!(r#"<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">{RED_RECT_SVG}"#);
    assert_eq!(probe_fetched(svg.clone().into_bytes()), RED);
    let data = format!("data:image/svg+xml;base64,{}", b64(svg.as_bytes()));
    assert_eq!(probe(&body(&format!(r#"<img src="{data}" width="100" height="100">"#))), RED);
}

#[test]
fn escaped_markup_in_an_inline_svg_cannot_read_a_file() {
    // blitz-dom writes text nodes unescaped when it serialises an inline <svg> for usvg, so
    // this text reaches usvg as a real <image>. The resolver is the line that holds.
    let secret = SecretFile::new("escaped");
    let svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><g>&lt;image href="{}" width="100" height="100"/&gt;</g></svg>"#,
        secret.href()
    );
    let (px, requests) = probe_pts(&body(&svg), &[(50, 50)]);
    assert_eq!(requests, 0);
    assert_eq!(px[0], WHITE, "the file was drawn into the mail");
}

// ---- nested rasters are charged per use, against one document budget ----

#[test]
fn one_data_svg_used_many_times_cannot_pass_the_document_budget() {
    // One SVG holding a 4 Mpx raster, used by five elements. usvg's renderer decodes the
    // raster again for every element that draws it, so each use is charged: four fit the
    // 16 Mpx a document's nested rasters may take, the fifth is not drawn.
    let png = format!("data:image/png;base64,{}", b64(&red_png_4_megapixels()));
    let svg = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="100"><image href="{png}" x="0" y="0" width="40" height="100"/></svg>"#);
    let url = format!("data:image/svg+xml;base64,{}", b64(svg.as_bytes()));
    let divs: String = (0..5).map(|_| format!(r#"<div style="float:left;width:40px;height:100px;background-image:url('{url}')"></div>"#)).collect();
    let (px, _) = probe_pts(&body(&divs), &[(20, 50), (60, 50), (100, 50), (140, 50), (180, 50)]);
    assert_eq!(px.iter().filter(|p| **p == RED).count(), 4, "{px:?}");
}

#[test]
fn inline_svgs_share_the_document_budget_for_nested_rasters() {
    let png = format!("data:image/png;base64,{}", b64(&red_png_4_megapixels()));
    let svg = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="100" style="float:left"><image href="{png}" x="0" y="0" width="40" height="100"/></svg>"#);
    let (px, _) = probe_pts(&body(&svg.repeat(5)), &[(20, 50), (60, 50), (100, 50), (140, 50), (180, 50)]);
    assert_eq!(px.iter().filter(|p| **p == RED).count(), 4, "{px:?}");
}

#[test]
fn an_svg_without_nested_rasters_is_drawn_any_number_of_times() {
    let url = format!("data:image/svg+xml;base64,{}", b64(r##"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="100"><rect width="20" height="100" fill="#f00"/></svg>"##.as_bytes()));
    let divs: String = (0..10).map(|_| format!(r#"<div style="float:left;width:20px;height:100px;background-image:url('{url}')"></div>"#)).collect();
    let (px, _) = probe_pts(&body(&divs), &(0..10).map(|i| (i * 20 + 10, 50)).collect::<Vec<_>>());
    assert!(px.iter().all(|p| *p == RED), "{px:?}");
}

// ---- vector complexity: `<use>` fan-out ----

/// A red 10x10 SVG built from `levels` layers of `fan` `<use>` copies each: usvg copies the
/// linked subtree for every `<use>`, so a kilobyte of markup becomes `fan^levels` rectangles.
fn fan_svg(levels: u32, fan: u32) -> String {
    let mut defs = String::from(r##"<g id="l0"><rect width="10" height="10" fill="#f00"/></g>"##);
    for l in 1..=levels {
        let uses = format!(r##"<use href="#l{}"/>"##, l - 1).repeat(fan as usize);
        defs.push_str(&format!(r#"<g id="l{l}">{uses}</g>"#));
    }
    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><defs>{defs}</defs><use href="#l{levels}"/></svg>"##
    )
}

/// `rows` variants of `fan_svg(levels, fan)` (a comment makes each one a different url
/// when `wrap` makes it an `<img>`), one per 10 px row of a document 10 px wide.
/// Returns how many rows painted red, how long the open took, and the markup size.
fn red_rows(levels: u32, fan: u32, rows: u32, wrap: impl Fn(&str) -> String) -> (u32, std::time::Duration, usize) {
    let svg = fan_svg(levels, fan);
    let html = body(
        &(0..rows)
            .map(|i| format!(r#"<div style="height:10px;overflow:hidden">{}</div>"#, wrap(&svg.replacen("<defs>", &format!("<!--{i}--><defs>"), 1))))
            .collect::<String>(),
    );
    let t = std::time::Instant::now();
    let net = BridgeNet::new(true);
    let mut doc = RenderDoc::open(&html, RenderOptions::new(200, 1.0), Some(net)).unwrap();
    doc.apply_resources();
    let took = t.elapsed();
    let png = doc.tile_png(0).unwrap();
    let red = (0..rows).filter(|i| rgb_at(&png, 5, i * 10 + 5) == RED).count() as u32;
    (red, took, html.len())
}

fn data_img(svg: &str) -> String {
    format!(r#"<img style="display:block" width="10" height="10" src="data:image/svg+xml;base64,{}">"#, b64(svg.as_bytes()))
}

#[test]
fn a_fan_out_bomb_is_refused_in_bounded_time() {
    // About 1 KB of markup that usvg expands to 300,000 nodes: past what one SVG may keep.
    let (red, took, bytes) = red_rows(5, 10, 1, |s| s.to_string());
    assert!(bytes < 4096, "the bomb is small markup: {bytes} bytes");
    assert_eq!(red, 0, "a bomb tree was kept and drawn");
    assert!(took.as_secs() < 20, "opening one bomb took {took:?}");
}

#[test]
fn a_marker_fan_out_is_refused() {
    // Not a `<use>`: a 30,000-vertex path draws its marker at every vertex, and usvg builds a
    // group per marker instance. ~150 KB of markup, 90,000+ nodes, no `<use>` to count.
    let verts = " L51 50 L50 50".repeat(15_000);
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><defs><marker id="m" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10"><rect width="10" height="10" fill="#f00"/><rect width="10" height="10" fill="#f00"/><rect width="10" height="10" fill="#f00"/></marker></defs><path d="M50 50{verts}" fill="none" stroke="#fff" marker-start="url(#m)" marker-mid="url(#m)" marker-end="url(#m)"/></svg>"##
    );
    let small = svg.replace(&verts, " L51 50 L50 50");
    assert_eq!(probe(&body(&small)), RED, "the same SVG with few vertices draws its marker");
    assert_eq!(probe(&body(&svg)), WHITE, "a marker bomb was kept and drawn");
}

#[test]
fn ten_bombs_in_one_document_open_in_bounded_time_and_draw_nothing() {
    for wrap in [(|s: &str| s.to_string()) as fn(&str) -> String, data_img] {
        let (red, took, _) = red_rows(5, 10, 10, wrap);
        assert_eq!(red, 0, "a bomb tree was kept and drawn");
        assert!(took.as_secs() < 60, "opening ten bombs took {took:?}");
    }
}

#[test]
fn svgs_under_the_per_svg_cap_still_share_one_document_budget() {
    // Each of these is some 26,000 nodes, under the per-SVG cap of 50,000; the document
    // keeps at most 200,000 in all, so about seven of ten are drawn, inline or as images.
    for wrap in [(|s: &str| s.to_string()) as fn(&str) -> String, data_img] {
        let (red, took, _) = red_rows(5, 6, 10, wrap);
        assert!(took.as_secs() < 30, "opening ten took {took:?}");
        assert!((5..=8).contains(&red), "{red} of 10 drawn");
    }
}

#[test]
fn a_normal_svg_logo_is_not_charged_into_refusal() {
    for wrap in [(|s: &str| s.to_string()) as fn(&str) -> String, data_img] {
        assert_eq!(red_rows(2, 3, 10, wrap).0, 10);
    }
}
