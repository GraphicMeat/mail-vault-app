use anyrender::ImageRenderer;
use anyrender_vello_cpu::VelloCpuImageRenderer;
use blitz_dom::DocumentConfig;
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};

/// Task 0 smoke: lay out `html` and paint its first 512 CSS px to PNG bytes.
pub fn smoke_png(html: &str, css_width: u32, scale: f32) -> Vec<u8> {
    let px_w = (css_width as f32 * scale).round() as u32;
    let px_h = (512.0 * scale).round() as u32;
    let mut doc = HtmlDocument::from_html(
        html,
        DocumentConfig { viewport: Some(Viewport::new(px_w, px_h, scale, ColorScheme::Light)), ..Default::default() },
    );
    doc.resolve(0.0);
    let mut painter = VelloCpuImageRenderer::new(px_w, px_h);
    let mut rgba = vec![0u8; (px_w * px_h * 4) as usize];
    painter.render(|scene| blitz_paint::paint_scene(scene, &mut doc, scale as f64, px_w, px_h, 0, 0), &mut rgba);
    let mut out = Vec::new();
    let mut enc = png::Encoder::new(&mut out, px_w, px_h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().unwrap().write_image_data(&rgba).unwrap();
    out
}
