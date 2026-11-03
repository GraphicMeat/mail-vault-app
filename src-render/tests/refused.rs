//! A picture refused for size is reported with its box, so the reader can put a
//! button on it that opens the original. Only `<img data-mv-img>` is reported:
//! the pre-pass stamps every `<img>` of the mail with its number.
use base64::Engine;
use mailvault_render::net::BridgeNet;
use mailvault_render::{RenderDoc, RenderOptions};

fn opts() -> RenderOptions { RenderOptions::new(600, 1.0) }

/// The first 33 bytes of a PNG that declares `w` x `h`: no pixel data at all.
fn png_header(w: u32, h: u32) -> Vec<u8> {
    let mut v = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
    v.extend(w.to_be_bytes());
    v.extend(h.to_be_bytes());
    v.extend([8, 2, 0, 0, 0, 0, 0, 0, 0]);
    v
}

fn data_url(bytes: &[u8]) -> String {
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn open(html: &str) -> RenderDoc {
    RenderDoc::open(html, opts(), Some(BridgeNet::new(false))).unwrap()
}

#[test]
fn a_picture_over_the_decode_limit_is_reported_with_a_box() {
    let html = format!(r#"<body style="margin:0"><p>hi</p><img data-mv-img="3" src="{}"></body>"#, data_url(&png_header(20_000, 20_000)));
    let doc = open(&html);
    let found = doc.meta().refused_images;
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].id, "3");
    assert!(found[0].w >= 100.0 && found[0].h >= 40.0, "the placeholder is big enough to hold a button: {:?}", found[0]);
    assert!(found[0].w <= 600.0, "never wider than the document: {:?}", found[0]);
    assert!(found[0].y > 0.0, "it sits below the paragraph: {:?}", found[0]);
}

#[test]
fn the_box_keeps_the_pictures_shape() {
    let html = format!(r#"<img data-mv-img="0" src="{}">"#, data_url(&png_header(30_000, 10_000)));
    let found = open(&html).meta().refused_images;
    assert_eq!(found.len(), 1);
    let ratio = found[0].w / found[0].h;
    assert!((ratio - 3.0).abs() < 0.1, "3:1 stays 3:1, got {ratio}");
}

#[test]
fn a_picture_over_25_mb_of_file_is_reported() {
    let mut bytes = png_header(100, 100);
    bytes.resize(25 * 1024 * 1024 + 1, 0);
    let html = format!(r#"<img data-mv-img="1" src="{}">"#, data_url(&bytes));
    let found = open(&html).meta().refused_images;
    assert_eq!(found.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["1"]);
}

#[test]
fn a_picture_that_is_shrunk_is_not_reported() {
    let img = image::RgbImage::from_pixel(5000, 4000, image::Rgb([1, 2, 3]));
    let mut jpeg = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut jpeg), image::ImageFormat::Jpeg).unwrap();
    let html = format!(r#"<img data-mv-img="0" src="data:image/jpeg;base64,{}">"#, base64::engine::general_purpose::STANDARD.encode(&jpeg));
    assert!(open(&html).meta().refused_images.is_empty());
}

#[test]
fn a_picture_the_parser_did_not_stamp_is_not_reported() {
    let html = format!(r#"<img src="{}">"#, data_url(&png_header(20_000, 20_000)));
    assert!(open(&html).meta().refused_images.is_empty());
}

#[test]
fn bytes_that_are_not_a_picture_are_not_reported() {
    let junk = vec![7u8; 200_000];
    let html = format!(r#"<img data-mv-img="0" src="data:image/png;base64,{}">"#, base64::engine::general_purpose::STANDARD.encode(&junk));
    assert!(open(&html).meta().refused_images.is_empty());
}

#[test]
fn a_remote_picture_over_the_limit_is_reported_once_it_lands() {
    let net = BridgeNet::new(true);
    let mut doc = RenderDoc::open(r#"<img data-mv-img="2" src="https://img.example.com/big.png">"#, opts(), Some(net.clone())).unwrap();
    assert!(doc.meta().refused_images.is_empty(), "nothing is known before the answer");
    let req = net.take_outbox();
    assert_eq!(req.len(), 1);
    assert!(net.complete(req[0].id, Some(png_header(20_000, 20_000))));
    doc.apply_resources();
    let found = doc.meta().refused_images;
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].id, "2");
}

#[test]
fn a_report_survives_the_next_relayout() {
    let html = format!(r#"<img data-mv-img="0" src="{}">"#, data_url(&png_header(20_000, 20_000)));
    let mut doc = open(&html);
    let first = doc.meta().refused_images;
    doc.apply_resources();
    assert_eq!(doc.meta().refused_images, first);
}
