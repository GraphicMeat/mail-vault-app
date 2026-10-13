//! SVG is the one document format inside the worker that can name resources
//! itself: usvg (blitz-dom's SVG renderer) treats any non-`data:` image href as
//! a local file path. A hostile mail must not make the worker read a file, so
//! every route that reaches usvg is closed: inline `<svg>` image elements are
//! stripped before layout, and SVG / gzip bytes never leave `BridgeNet`.
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
    rgb_at(&doc.tile_png(0).unwrap(), 50, 50)
}

#[test]
fn fetched_svg_bytes_are_refused_whatever_the_declared_type() {
    assert_eq!(probe_fetched(RED_RECT_SVG.as_bytes().to_vec()), WHITE, "SVG bytes reached usvg");
}

#[test]
fn svg_hidden_behind_a_prolog_comment_bom_or_prefix_is_refused() {
    let variants = [
        format!("<?xml version=\"1.0\"?>\n{RED_RECT_SVG}"),
        format!("<!-- hi -->{RED_RECT_SVG}"),
        format!("\u{feff}  \n\t{RED_RECT_SVG}"),
        format!("<!DOCTYPE svg>{RED_RECT_SVG}"),
        r##"<s:svg xmlns:s="http://www.w3.org/2000/svg" width="100" height="100"><s:rect width="100" height="100" fill="#f00"/></s:svg>"##.to_string(),
    ];
    for v in variants {
        assert_eq!(probe_fetched(v.clone().into_bytes()), WHITE, "SVG bytes reached usvg: {v}");
    }
}

#[test]
fn gzip_bytes_are_refused_because_usvg_inflates_svgz() {
    assert_eq!(probe_fetched(gzip(RED_RECT_SVG.as_bytes())), WHITE, "svgz reached usvg");
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
