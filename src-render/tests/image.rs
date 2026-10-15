use mailvault_render::{doc_image::MAX_IMAGE_AREA_PX, RenderDoc, RenderOptions};

fn open(html: &str, w: u32, scale: f32, transparent: bool) -> RenderDoc {
    RenderDoc::open(html, RenderOptions { css_width: w, scale, transparent, ..Default::default() }, None).expect("open")
}

fn decode(png: &[u8]) -> (u32, u32, png::ColorType, Vec<u8>) {
    let mut r = png::Decoder::new(png).read_info().expect("png");
    let mut buf = vec![0; r.output_buffer_size()];
    let info = r.next_frame(&mut buf).expect("frame");
    buf.truncate(info.buffer_size());
    (info.width, info.height, info.color_type, buf)
}

#[test]
fn image_is_the_whole_document_at_doc_scale() {
    let mut d = open(r#"<html><body style="margin:0"><div style="height:1500px;background:#f00"></div></body></html>"#, 600, 2.0, false);
    let (w, h, _, _) = decode(&d.image_png().unwrap());
    assert_eq!((w, h), (1200, 3000));
}

#[test]
fn image_of_a_tall_doc_fits_the_area() {
    let mut d = open(r#"<html><body style="margin:0"><div style="height:30000px;background:#0f0"></div></body></html>"#, 600, 2.0, false);
    let (w, h, _, _) = decode(&d.image_png().unwrap());
    assert!((w as f64) * (h as f64) <= MAX_IMAGE_AREA_PX, "{w}x{h}");
    assert!(w < 1200 && w > 500, "{w}");
}

#[test]
fn a_transparent_doc_paints_clear_corners_and_opaque_text() {
    // The paragraph is 200 px tall, so row 100 exists in the 200 px tile.
    let html = r#"<html style="background:transparent"><body style="margin:0;background:transparent !important"><p style="color:#000;margin:0;font-size:40px;height:200px">x</p></body></html>"#;
    let mut d = open(html, 300, 1.0, true);
    let (w, h, ct, px) = decode(&d.tile_png(0).unwrap());
    assert_eq!(ct, png::ColorType::Rgba);
    assert!(h > 100, "tile is {h} px tall");
    let corner = (((100 * w) + 299) * 4) as usize;
    assert_eq!(px[corner + 3], 0, "corner pixel must be transparent");
    assert!(px.chunks_exact(4).any(|p| p[3] == 255), "the glyph must stay opaque");
}

#[test]
fn a_transparent_image_is_rgba_with_clear_background() {
    let html = r#"<html style="background:transparent"><body style="margin:0;background:transparent !important"><p style="color:#000;margin:0;font-size:40px;height:200px">x</p></body></html>"#;
    let mut d = open(html, 300, 1.0, true);
    let (w, _, ct, px) = decode(&d.image_png().unwrap());
    assert_eq!(ct, png::ColorType::Rgba);
    assert_eq!(px[(((100 * w) + 299) * 4 + 3) as usize], 0);
}

#[test]
fn the_default_stays_opaque_rgb_over_white() {
    let mut d = open(r#"<html><body style="margin:0"><p>x</p></body></html>"#, 300, 1.0, false);
    let (_, _, ct, _) = decode(&d.tile_png(0).unwrap());
    assert_eq!(ct, png::ColorType::Rgb);
    let (_, _, ct, _) = decode(&d.image_png().unwrap());
    assert_eq!(ct, png::ColorType::Rgb);
}
