//! Dark Reader's `data:` background images (analyzeImage, getBgImageValue,
//! getFilteredImageURL). Remote and relative URLs never reach the analysis.
//! The images are mail-controlled: the pixel cap (`net::MAX_IMAGE_PIXELS`) is
//! read from the header before any decoder runs.
use base64::Engine;
use image::{Rgba, RgbaImage};
use mailvault_render::dark::image::{analyze, bg_image_value, decode_data_url, ImageCache};
use mailvault_render::dark::{DarkCx, DarkTheme, Profile, Theme};
use mailvault_render::net::{BridgeNet, MAX_DOC_IMAGE_PIXELS, MAX_IMAGE_PIXELS};
use mailvault_render::{RenderDoc, RenderOptions};

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
fn data_url(img: &RgbaImage) -> String {
    let mut png = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
    format!("data:image/png;base64,{}", b64(&png))
}
fn half_transparent(w: u32, h: u32, rgb: [u8; 3]) -> RgbaImage {
    RgbaImage::from_fn(w, h, |x, _| if x % 2 == 0 { Rgba([rgb[0], rgb[1], rgb[2], 255]) } else { Rgba([0, 0, 0, 0]) })
}
fn cx() -> DarkCx {
    DarkCx::new(Theme::mailvault("#0a0a12", "#e8e8ef", 100.0, 100.0, 0.0), Profile::WEBKIT_IFRAME)
}
fn unwrap_url(v: &str) -> &str {
    v.trim_start_matches("url(\"").trim_end_matches("\")")
}

#[test]
fn analysis_classifies_like_dark_reader() {
    let d = analyze(&half_transparent(40, 20, [32, 32, 32]));
    assert!(d.is_dark && d.is_transparent && !d.is_light && !d.is_large);
    let hero = analyze(&RgbaImage::from_pixel(600, 600, Rgba([240, 240, 240, 255])));
    assert!(hero.is_light && hero.is_large && !hero.is_transparent);
}

#[test]
fn transparent_dark_logo_is_inverted() {
    let url = data_url(&half_transparent(40, 20, [32, 32, 32]));
    let out = bg_image_value(&url, &mut cx()).expect("inverted");
    assert!(out.starts_with("url(\"data:image/png;base64,"));
    let filtered = decode_data_url(unwrap_url(&out)).unwrap();
    let p = filtered.get_pixel(0, 0);
    assert!(p[0] > 180 && p[3] == 255, "dark ink became light: {p:?}");
    assert_eq!(filtered.get_pixel(1, 0)[3], 0, "transparency kept");
}

#[test]
fn two_pixel_spacer_is_not_inverted() {
    assert_eq!(bg_image_value(&data_url(&half_transparent(2, 20, [32, 32, 32])), &mut cx()), None);
}

#[test]
fn large_light_image_is_hidden() {
    let url = data_url(&RgbaImage::from_pixel(600, 600, Rgba([240, 240, 240, 255])));
    assert_eq!(bg_image_value(&url, &mut cx()).as_deref(), Some("none"));
}

#[test]
fn large_dark_transparent_image_vanishes_as_in_dark_reader() {
    // DR drops the data URL of a large image before filtering it, so its
    // inverted copy is an <image> with an empty href: nothing is drawn.
    let url = data_url(&half_transparent(600, 600, [32, 32, 32]));
    assert_eq!(bg_image_value(&url, &mut cx()).as_deref(), Some("none"));
}

#[test]
fn small_light_image_is_dimmed() {
    let url = data_url(&RgbaImage::from_pixel(100, 100, Rgba([235, 235, 235, 255])));
    let out = bg_image_value(&url, &mut cx()).unwrap();
    let px = *decode_data_url(unwrap_url(&out)).unwrap().get_pixel(5, 5);
    // 235 grey inverted in linearRGB lands near 114 (sRGB): 0.8308 linear -> 0.1684 -> 0.447.
    assert!((105..=125).contains(&px[0]), "light became mid-dark, as DR's linearRGB filter does: {px:?}");
}

#[test]
fn mid_tone_image_is_kept() {
    assert_eq!(bg_image_value(&data_url(&RgbaImage::from_pixel(50, 50, Rgba([128, 128, 128, 255]))), &mut cx()), None);
}

#[test]
fn only_mode_one_changes_images() {
    let mut c = cx();
    c.theme.mode = 0;
    assert_eq!(bg_image_value(&data_url(&RgbaImage::from_pixel(100, 100, Rgba([235, 235, 235, 255]))), &mut c), None);
}

#[test]
fn remote_image_is_untouched() {
    use mailvault_render::dark::modify_css::{bg_image_modifier, RuleStyle};
    struct R;
    impl RuleStyle for R {
        fn get_property_value(&self, _: &str) -> String { String::new() }
        fn get_property_priority(&self, _: &str) -> bool { false }
    }
    let v = r#"url("https://cdn.blitz-corpus.invalid/a.png")"#;
    assert_eq!(bg_image_modifier(v, &R, &mut cx()).as_deref(), Some(v));
}

#[test]
fn percent_encoded_data_is_decoded() {
    let mut png = Vec::new();
    RgbaImage::from_pixel(3, 2, Rgba([9, 8, 7, 255])).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
    let enc: String = png.iter().map(|b| format!("%{b:02x}")).collect();
    let img = decode_data_url(&format!("data:image/png,{enc}")).unwrap();
    assert_eq!((img.width(), img.height(), img.get_pixel(1, 1).0), (3, 2, [9, 8, 7, 255]));
}

#[test]
fn undecodable_and_unsupported_data_keeps_the_url() {
    let mut c = cx();
    assert_eq!(bg_image_value("data:image/png;base64,AAAA", &mut c), None);
    assert_eq!(bg_image_value("data:text/plain,hello", &mut c), None);
    // SVG data: is not rasterised (known difference): the URL stays.
    let svg = format!("data:image/svg+xml;base64,{}", b64(br##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#202020"/></svg>"##));
    assert_eq!(bg_image_value(&svg, &mut c), None);
    assert_eq!(c.images.decoded_pixels, 0);
}

// ---- mail-controlled bytes: nothing is decoded beyond the render crate's cap ----

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

/// A PNG that declares `w` x `h` and holds no pixel data at all: any decoder that
/// trusted the header would try to allocate `w * h * 4` bytes.
fn png_header_only(w: u32, h: u32) -> Vec<u8> {
    let mut ihdr = b"IHDR".to_vec();
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
    out.extend_from_slice(&ihdr);
    out.extend_from_slice(&crc32(&ihdr).to_be_bytes());
    out
}

#[test]
fn a_declared_huge_raster_is_refused_without_decoding() {
    let mut c = cx();
    for (w, h) in [(100_000u32, 100_000u32), (4001, 4001), (u32::MAX, u32::MAX), (1, u32::MAX)] {
        assert!(w as u64 * h as u64 > MAX_IMAGE_PIXELS);
        let url = format!("data:image/png;base64,{}", b64(&png_header_only(w, h)));
        assert_eq!(bg_image_value(&url, &mut c), None, "{w}x{h}");
        assert!(decode_data_url(&url).is_none(), "{w}x{h}");
    }
    assert_eq!(c.images.decoded_pixels, 0, "a refused image must not reach a decoder");
}

#[test]
fn a_raster_at_the_cap_is_still_read_from_its_header() {
    // 4000 x 4000 = 16 Mpx is allowed by the cap; this header-only file then fails to
    // decode (no pixel data) inside the bounded decoder, which is a plain None.
    let mut c = cx();
    let url = format!("data:image/png;base64,{}", b64(&png_header_only(4000, 4000)));
    assert_eq!(bg_image_value(&url, &mut c), None);
}

#[test]
fn a_document_cannot_decode_more_than_the_image_budget_in_total() {
    let mut c = cx();
    c.images.decoded_pixels = MAX_DOC_IMAGE_PIXELS - 5_000;
    let url = data_url(&RgbaImage::from_pixel(100, 100, Rgba([235, 235, 235, 255])));
    assert_eq!(bg_image_value(&url, &mut c), None, "over budget: the url is kept");
    let small = data_url(&RgbaImage::from_pixel(10, 10, Rgba([235, 235, 235, 255])));
    assert!(bg_image_value(&small, &mut c).is_some(), "within budget still works");
}

#[test]
fn one_url_is_decoded_once() {
    let mut c = cx();
    let url = data_url(&RgbaImage::from_pixel(100, 100, Rgba([235, 235, 235, 255])));
    let a = bg_image_value(&url, &mut c);
    let b = bg_image_value(&url, &mut c);
    assert_eq!(a, b);
    assert_eq!(c.images.decoded_pixels, 10_000);
    let _ = ImageCache::default();
}

// ---- through the pipeline ----

fn theme() -> DarkTheme {
    DarkTheme { bg: "#0a0a12".into(), fg: "#e8e8ef".into(), brightness: 100.0, contrast: 100.0, sepia: 0.0, top_level: false }
}
fn page(css_url: &str) -> String {
    format!(
        "<!doctype html><html><head><style>html,body{{margin:0;background:#fff}}.l{{width:40px;height:20px;background-image:url(\"{css_url}\")}}</style></head><body><div class=\"l\"></div></body></html>"
    )
}

#[test]
fn the_sync_rules_carry_the_inverted_image() {
    let url = data_url(&half_transparent(40, 20, [32, 32, 32]));
    let css = mailvault_render::dark::debug_sync_css(&page(&url), &theme()).concat();
    assert!(css.contains("background-image"), "{css}");
    assert!(!css.contains(&url), "the original data URL was left in place");
    assert!(css.contains("data:image/png;base64,"));
}

#[test]
fn a_huge_declared_raster_in_css_keeps_its_url() {
    let url = format!("data:image/png;base64,{}", b64(&png_header_only(100_000, 100_000)));
    let css = mailvault_render::dark::debug_sync_css(&page(&url), &theme()).concat();
    assert!(css.contains(&url), "the refused image's URL must stay as written");
}

#[test]
fn a_dark_logo_background_paints_light() {
    let url = data_url(&half_transparent(40, 20, [32, 32, 32]));
    let net = BridgeNet::new(false);
    let opts = RenderOptions { dark: Some(theme()), ..RenderOptions::new(100, 1.0) };
    let mut doc = RenderDoc::open(&page(&url), opts, Some(net)).unwrap();
    doc.apply_resources();
    let png = doc.tile_png(0).unwrap();
    let mut r = png::Decoder::new(std::io::Cursor::new(&png)).read_info().unwrap();
    let mut buf = vec![0; r.output_buffer_size()];
    let info = r.next_frame(&mut buf).unwrap();
    let ch = info.color_type.samples();
    let px = &buf[..ch];
    assert!(px[0] > 150, "the logo ink should paint light on the dark page: {px:?}");
}

#[test]
fn a_body_background_attribute_data_image_is_analysed_too() {
    use blitz_dom::local_name;
    let url = data_url(&half_transparent(40, 20, [32, 32, 32]));
    let html = format!("<!doctype html><html><body background=\"{url}\">x</body></html>");
    let doc = blitz_html::HtmlDocument::from_html(&html, blitz_dom::DocumentConfig::default());
    let body = doc.tree().iter().find(|(_, n)| n.attr(local_name!("background")).is_some()).map(|(id, _)| id).expect("body");
    let edits = mailvault_render::dark::inline::override_inline(&doc, body, &mut cx());
    let bg = edits.props.iter().find(|(k, _)| k == "--darkreader-inline-bgimage").expect("bgimage override").1.clone();
    assert!(bg.starts_with("url(\"data:image/png;base64,") && !bg.contains(&url), "the background attribute kept its original image");
}

/// The `--darkreader-inline-bgimage` that `override_inline` writes on `<body background>`.
fn body_background_override(bg: &str) -> String {
    use blitz_dom::local_name;
    let html = format!("<!doctype html><html><body background=\"{bg}\">x</body></html>");
    let doc = blitz_html::HtmlDocument::from_html(&html, blitz_dom::DocumentConfig::default());
    let body = doc.tree().iter().find(|(_, n)| n.attr(local_name!("background")).is_some()).map(|(id, _)| id).expect("body");
    let edits = mailvault_render::dark::inline::override_inline(&doc, body, &mut cx());
    edits.props.iter().find(|(k, _)| k == "--darkreader-inline-bgimage").expect("bgimage override").1.clone()
}

#[test]
fn a_body_background_attribute_kept_as_it_is_becomes_none() {
    // DR's setAsyncValue: on html/body an image the modifier hands back unchanged (a remote
    // one DR cannot fetch, or a mid-tone one it keeps) is dropped, as on the style path.
    assert_eq!(body_background_override("https://x.test/paper.jpg"), "none");
    let mid = data_url(&RgbaImage::from_pixel(50, 50, Rgba([128, 128, 128, 255])));
    assert_eq!(body_background_override(&mid), "none");
}

/// A light, noisy (barely compressible) 500 x 500 image: DR dims it through a filtered PNG.
fn noisy_light(seed: u32) -> RgbaImage {
    let mut s = seed.wrapping_mul(2_654_435_761).wrapping_add(1);
    RgbaImage::from_fn(500, 500, |_, _| {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        let b = s.to_le_bytes();
        Rgba([200 + b[0] % 56, 200 + b[1] % 56, 200 + b[2] % 56, 255])
    })
}

#[test]
fn a_document_cannot_emit_more_than_its_budget_of_filtered_images() {
    let mut c = cx();
    let mut emitted = 0usize;
    let mut kept = 0;
    for i in 0..20 {
        match bg_image_value(&data_url(&noisy_light(i)), &mut c) {
            Some(v) => emitted += v.len(),
            None => kept += 1,
        }
    }
    eprintln!("emitted {emitted} bytes, kept {kept} urls");
    assert!(emitted <= 16 * 1024 * 1024, "emitted {emitted} bytes of filtered images");
    assert!(kept > 0, "past the budget an image keeps its url");
}
