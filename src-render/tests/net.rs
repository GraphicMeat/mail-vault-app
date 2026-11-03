use base64::Engine;
use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request, Url};
use mailvault_render::net::BridgeNet;
use mailvault_render::{RenderDoc, RenderOptions};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

const RED_1PX_PNG_B64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

fn opts() -> RenderOptions { RenderOptions::new(200, 1.0) }

#[test]
fn data_url_image_is_decoded_in_process_and_never_queued() {
    let net = BridgeNet::new(true);
    let html = format!(r#"<body style="margin:0"><img src="data:image/png;base64,{RED_1PX_PNG_B64}" width="50" height="50"></body>"#);
    let mut doc = RenderDoc::open(&html, opts(), Some(net.clone())).unwrap();
    assert!(net.take_outbox().is_empty());
    doc.apply_resources();
    let png = doc.tile_png(0).unwrap();
    let mut r = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
    let mut buf = vec![0; r.output_buffer_size()];
    r.next_frame(&mut buf).unwrap();
    assert_eq!(&buf[0..3], &[255, 0, 0], "decoded data: image painted");
}

#[test]
fn https_image_is_queued_once_with_its_url() {
    let net = BridgeNet::new(true);
    let _doc = RenderDoc::open(r#"<img src="https://img.example.com/a.png">"#, opts(), Some(net.clone())).unwrap();
    let out = net.take_outbox();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].url, "https://img.example.com/a.png");
    assert!(net.take_outbox().is_empty(), "outbox drains");
}

#[test]
fn http_file_and_cid_are_denied_without_queueing() {
    let net = BridgeNet::new(true);
    let html = r#"<img src="http://a.example/x.png"><img src="file:///etc/passwd"><img src="cid:abc">"#;
    let _doc = RenderDoc::open(html, opts(), Some(net.clone())).unwrap();
    assert!(net.take_outbox().is_empty());
}

#[test]
fn remote_off_queues_nothing() {
    let net = BridgeNet::new(false);
    let _doc = RenderDoc::open(r#"<img src="https://img.example.com/a.png">"#, opts(), Some(net.clone())).unwrap();
    assert!(net.take_outbox().is_empty());
}

#[test]
fn remote_stylesheet_is_answered_empty_at_once_and_does_not_block_paint() {
    let net = BridgeNet::new(true);
    let html = r#"<link rel="stylesheet" href="https://css.example.com/s.css"><body style="margin:0;background:#00f"><div style="height:20px"></div></body>"#;
    let mut doc = RenderDoc::open(html, opts(), Some(net.clone())).unwrap();
    assert!(net.take_outbox().is_empty(), "no network request for a stylesheet: the iframe makes none either");
    assert!(!doc.has_pending_critical(), "the stylesheet was answered, so nothing holds the paint");
    let png = doc.tile_png(0).unwrap();
    let mut r = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
    let mut buf = vec![0; r.output_buffer_size()];
    r.next_frame(&mut buf).unwrap();
    assert_eq!(&buf[0..3], &[0, 0, 255], "body painted, not blank");
}

#[test]
fn complete_unknown_id_is_false_and_fail_all_answers_everything() {
    let net = BridgeNet::new(true);
    let html = r#"<link rel="stylesheet" href="https://css.example.com/s.css"><img src="https://img.example.com/a.png">"#;
    let mut doc = RenderDoc::open(html, opts(), Some(net.clone())).unwrap();
    assert!(!net.complete(9999, None));
    let out = net.take_outbox();
    assert_eq!(out.len(), 1, "only the image is queued");
    assert_eq!(out[0].url, "https://img.example.com/a.png");
    net.fail_all();
    doc.apply_resources();
    assert!(!doc.has_pending_critical());
}

fn queued_urls(html: &str) -> Vec<String> {
    queued_urls_in(html, opts())
}

fn queued_urls_in(html: &str, opts: RenderOptions) -> Vec<String> {
    let net = BridgeNet::new(true);
    let mut doc = RenderDoc::open(html, opts, Some(net.clone())).unwrap();
    doc.apply_resources();
    net.take_outbox().into_iter().map(|f| f.url).collect()
}

/// Cases whose remote import / font / frame URLs must never reach the daemon.
const PRIVACY_CASES: [&str; 10] = [
    r#"<style>@import url(https://css.example.com/a.css);</style><p>x"#,
    r#"<style>@import "https://css.example.com/b.css";</style><p>x"#,
    r#"<style>@font-face{font-family:f;src:url(https://fonts.example.com/f.woff2) format("woff2")}</style><p style="font-family:f">x"#,
    r#"<style>@font-face{font-family:f;src:url(https://fonts.example.com/f.ttf)}</style><p style="font-family:f">x"#,
    r#"<iframe src="https://frame.example.com/f.html"></iframe>"#,
    r#"<iframe srcdoc="&lt;img src=&quot;https://img.example.com/in-frame.png&quot;&gt;"></iframe>"#,
    r#"<link rel="stylesheet" href="https://css.example.com/s.css"><link rel="icon" href="https://img.example.com/i.png">"#,
    // A data: stylesheet is answered during the parse but applied afterwards: its
    // @font-face and @import must be held to the same rule as an inline <style>.
    r#"<link rel="stylesheet" href="data:text/css,@font-face%7Bfont-family:f%3Bsrc:url(https://fonts.example.com/f.woff2)%7D"><p style="font-family:f">x"#,
    r#"<link rel="stylesheet" href="data:text/css,@import%20url(https://css.example.com/n.css)%3B"><p>x"#,
    r#"<style>@import url("data:text/css,@font-face%7Bfont-family:f%3Bsrc:url(https://fonts.example.com/g.woff2)%7D");</style><p style="font-family:f">x"#,
];

#[test]
fn remote_import_font_and_frame_urls_are_never_requested() {
    for html in PRIVACY_CASES {
        let q = queued_urls(html);
        assert!(q.is_empty(), "{html} queued {q:?}");
    }
}

#[test]
fn remote_import_font_and_frame_urls_are_never_requested_in_dark_mode() {
    // A coloured SVG element makes dark mode run an early full layout (to measure
    // boxes). That pass must not ingest a data: stylesheet inside the CSS-image window.
    let theme = mailvault_render::dark::DarkTheme {
        bg: "#0a0a12".into(),
        fg: "#e8e8ef".into(),
        brightness: 100.0,
        contrast: 100.0,
        sepia: 0.0,
        top_level: false,
    };
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#ff0000"/></svg>"##;
    for html in PRIVACY_CASES {
        let opts = RenderOptions { dark: Some(theme.clone()), ..opts() };
        let q = queued_urls_in(&format!("{html}{svg}"), opts);
        assert!(q.is_empty(), "dark: {html} queued {q:?}");
    }
}

#[test]
fn iframes_are_switched_off() {
    let net = BridgeNet::new(true);
    let html = r#"<iframe srcdoc="&lt;p&gt;inside&lt;/p&gt;"></iframe><iframe src="data:text/html,hi"></iframe><p>x"#;
    let doc = RenderDoc::open(html, opts(), Some(net)).unwrap();
    assert_eq!(doc.subdocument_count(), 0);
}

#[test]
fn css_images_are_still_fetched() {
    for html in [
        r#"<style>body{background:url(https://img.example.com/bg.png)}</style><p>x"#,
        r#"<p style="background-image:url('https://img.example.com/bg.png')">x"#,
    ] {
        assert_eq!(queued_urls(html), ["https://img.example.com/bg.png"], "{html}");
    }
}

#[test]
fn repeated_image_urls_are_requested_once() {
    let q = queued_urls(r#"<img src="https://img.example.com/a.png"><img src="https://img.example.com/a.png"><img src="https://img.example.com/b.png">"#);
    assert_eq!(q, ["https://img.example.com/a.png", "https://img.example.com/b.png"]);
}

// ---- Fix A: images are measured before anything decodes them ----

/// Records how many bytes the document's handler was finally given.
struct Rec(Arc<Mutex<Option<usize>>>);
impl NetHandler for Rec {
    fn bytes(self: Box<Self>, _url: String, bytes: Bytes) {
        *self.0.lock().unwrap() = Some(bytes.len());
    }
}

/// Fetch `url` through `net` and report the length of the answer (None: never answered).
fn answer(net: &BridgeNet, url: &str) -> Option<usize> {
    let got = Arc::new(Mutex::new(None));
    net.fetch(0, Request::get(Url::parse(url).unwrap()), Box::new(Rec(got.clone())));
    let v = *got.lock().unwrap();
    v
}

/// The first 33 bytes of a PNG that declares `w` x `h`: no pixel data at all.
fn png_header(w: u32, h: u32) -> Vec<u8> {
    let mut v = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
    v.extend(w.to_be_bytes());
    v.extend(h.to_be_bytes());
    v.extend([8, 2, 0, 0, 0, 0, 0, 0, 0]);
    v
}
fn data_png(w: u32, h: u32) -> String {
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png_header(w, h)))
}

/// Like `answer`, but the bytes the document's handler was finally given.
fn answer_bytes(net: &BridgeNet, url: &str) -> Vec<u8> {
    struct Keep(Arc<Mutex<Vec<u8>>>);
    impl NetHandler for Keep {
        fn bytes(self: Box<Self>, _url: String, bytes: Bytes) {
            *self.0.lock().unwrap() = bytes.to_vec();
        }
    }
    let got = Arc::new(Mutex::new(Vec::new()));
    net.fetch(0, Request::get(Url::parse(url).unwrap()), Box::new(Keep(got.clone())));
    let v = got.lock().unwrap().clone();
    v
}

/// A real, decodable one-colour JPEG (a few KiB however large it is).
fn solid_jpeg(w: u32, h: u32, rgb: [u8; 3]) -> Vec<u8> {
    let img = image::RgbImage::from_pixel(w, h, image::Rgb(rgb));
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Jpeg).unwrap();
    out
}
fn data_jpeg(bytes: &[u8]) -> String {
    format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

// A photo past the per-image limit is shown smaller, never dropped: whatever the
// sender attached has to be viewable. The limit only bounds what is decoded for paint.
#[test]
fn an_image_over_the_per_image_limit_is_shrunk_not_refused() {
    let net = BridgeNet::new(false);
    let out = answer_bytes(&net, &data_jpeg(&solid_jpeg(4500, 4000, [200, 30, 30])));
    assert!(!out.is_empty(), "an 18 MP photo is answered");
    let size = imagesize::blob_size(&out).unwrap();
    assert!(size.width as u64 * size.height as u64 <= 16_000_000, "{}x{}", size.width, size.height);
    let (w, h) = (size.width as f64, size.height as f64);
    assert!((w / h - 4500.0 / 4000.0).abs() < 0.01, "aspect ratio kept: {w}x{h}");
}

#[test]
fn an_image_that_does_not_fit_what_is_left_of_the_budget_is_shrunk_to_it() {
    let net = BridgeNet::new(false);
    for _ in 0..3 {
        assert!(answer(&net, &data_png(4000, 4000)).unwrap() > 0);
    }
    assert!(answer(&net, &data_png(3800, 3800)).unwrap() > 0); // 14.44 MP: 1.56 MP left
    let out = answer_bytes(&net, &data_jpeg(&solid_jpeg(2000, 1000, [10, 200, 10])));
    assert!(!out.is_empty(), "a 2 MP photo still gets an answer");
    let size = imagesize::blob_size(&out).unwrap();
    assert!(size.width as u64 * size.height as u64 <= 1_560_000, "{}x{}", size.width, size.height);
}

#[test]
fn a_shrunk_photo_paints_in_the_document() {
    let net = BridgeNet::new(true);
    let html = format!(r#"<body style="margin:0"><img src="{}" width="100" height="89"></body>"#, data_jpeg(&solid_jpeg(4500, 4000, [220, 20, 20])));
    let mut doc = RenderDoc::open(&html, opts(), Some(net)).unwrap();
    doc.apply_resources();
    let png = doc.tile_png(0).unwrap();
    let mut r = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
    let mut buf = vec![0; r.output_buffer_size()];
    let info = r.next_frame(&mut buf).unwrap();
    let ch = info.color_type.samples();
    let at = (10 * info.width as usize + 10) * ch;
    assert!(buf[at] > 180 && buf[at + 1] < 80, "the photo's red is painted, got {:?}", &buf[at..at + 3]);
}

/// A PNG header declaring a small picture, padded to `len` bytes: a file of that size, to the size check.
fn padded_png(len: usize) -> String {
    let mut v = png_header(100, 100);
    v.resize(len, 0);
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(v))
}

#[test]
fn a_picture_is_viewable_up_to_25_mb_of_file() {
    let net = BridgeNet::new(false);
    assert!(answer(&net, &padded_png(25 * 1024 * 1024)).unwrap() > 0, "exactly 25 MB passes");
    let net = BridgeNet::new(false);
    assert_eq!(answer(&net, &padded_png(25 * 1024 * 1024 + 1)), Some(0), "one byte over is refused");
}

#[test]
fn a_png_declaring_400_megapixels_is_answered_empty() {
    let net = BridgeNet::new(false);
    assert_eq!(answer(&net, &data_png(20_000, 20_000)), Some(0));
}

#[test]
fn the_per_image_limit_is_sixteen_megapixels() {
    let net = BridgeNet::new(false);
    assert_eq!(answer(&net, &data_png(4000, 4000)).map(|n| n > 0), Some(true), "exactly 16 MP passes");
    let net = BridgeNet::new(false);
    assert_eq!(answer(&net, &data_png(4000, 4001)), Some(0), "one row over, with no pixels behind the header to shrink, is refused");
}

#[test]
fn a_document_may_not_exceed_its_cumulative_pixel_budget() {
    let net = BridgeNet::new(false);
    for i in 0..4 {
        assert!(answer(&net, &data_png(4000, 4000)).unwrap() > 0, "image {i} fits the 64 MP budget");
    }
    assert_eq!(answer(&net, &data_png(100, 100)), Some(0), "the next one does not");
}

#[test]
fn a_refused_image_does_not_spend_the_budget() {
    let net = BridgeNet::new(false);
    assert_eq!(answer(&net, &data_png(20_000, 20_000)), Some(0));
    for _ in 0..4 {
        assert!(answer(&net, &data_png(4000, 4000)).unwrap() > 0);
    }
}

#[test]
fn bytes_with_no_readable_header_pass_only_when_small() {
    let net = BridgeNet::new(false);
    assert!(answer(&net, "data:text/css,p%7Bcolor%3Ared%7D").unwrap() > 0, "a small stylesheet passes");
    let big = base64::engine::general_purpose::STANDARD.encode(vec![b'a'; 70_000]);
    assert_eq!(answer(&net, &format!("data:text/css;base64,{big}")), Some(0), "over 64 KiB with no size header is refused");
}

#[test]
fn fetched_https_bytes_get_the_same_header_check() {
    let net = BridgeNet::new(true);
    let got = Arc::new(Mutex::new(None));
    net.fetch(0, Request::get(Url::parse("https://img.example.com/huge.png").unwrap()), Box::new(Rec(got.clone())));
    assert!(net.take_outbox().is_empty(), "held until the document says it is an <img>");
    net.settle(&HashSet::from(["https://img.example.com/huge.png".to_string()]));
    let id = net.take_outbox()[0].id;
    assert!(net.complete(id, Some(png_header(20_000, 20_000))));
    assert_eq!(*got.lock().unwrap(), Some(0), "answered empty, never handed to the decoder");
}

#[test]
fn a_successor_net_numbers_its_fetches_after_the_old_net() {
    let a = BridgeNet::new(true);
    let _doc_a = RenderDoc::open(r#"<img src="https://img.example.com/a.png">"#, opts(), Some(a.clone())).unwrap();
    let a_id = a.take_outbox()[0].id;

    let b = BridgeNet::with_cache(true, a.cache());
    b.continue_ids_after(&a);
    let _doc_b = RenderDoc::open(r#"<img src="https://img.example.com/b.png">"#, opts(), Some(b.clone())).unwrap();
    let out = b.take_outbox();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].url, "https://img.example.com/b.png");
    assert!(out[0].id > a_id, "b {} must come after a {a_id}", out[0].id);
    assert!(!b.complete(a_id, Some(vec![1, 2, 3])), "a late answer to a's fetch cannot complete b's");
    assert!(b.complete(out[0].id, None), "b's own id still completes");
}
