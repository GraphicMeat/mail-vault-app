use anyrender::ImageRenderer;
use anyrender_vello_cpu::VelloCpuImageRenderer;
use blitz_dom::{local_name, DocumentConfig, NodeId, Point};
use blitz_html::HtmlDocument;
use blitz_traits::net::NetProvider;
use blitz_traits::shell::{ColorScheme, Viewport};
use serde::Serialize;
use std::sync::Arc;

pub const TILE_CSS_HEIGHT: u32 = 512;
pub const MAX_HTML_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_NODES: usize = 150_000;
pub const MAX_CSS_HEIGHT: f32 = 200_000.0;
/// Resolution base for relative URLs. `.invalid` is reserved (RFC 6761): it never resolves.
const BASE_URL: &str = "http://invalid.invalid/";

/// Plans B and D add fields (theme, transparency). Construct with `new` or
/// `..Default::default()`, never a bare literal, so their additions compile.
#[derive(Clone, Debug, Default)]
pub struct RenderOptions {
    pub css_width: u32,
    pub scale: f32,
}

impl RenderOptions {
    #[allow(clippy::needless_update)]
    pub fn new(css_width: u32, scale: f32) -> Self {
        Self { css_width, scale, ..Default::default() }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkInfo {
    pub href: String,
    pub text: String,
    pub alert: Option<String>,
    pub title: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocMeta {
    pub css_width: f32,
    pub css_height: f32,
    pub tile_css_height: u32,
    pub tile_count: u32,
    pub links: Vec<LinkInfo>,
    pub plain_text: String,
}

#[derive(Debug)]
pub enum OpenError {
    TooLarge,
    TooComplex,
}

impl OpenError {
    pub fn code(&self) -> &'static str {
        match self {
            OpenError::TooLarge => "render_too_large",
            OpenError::TooComplex => "render_too_complex",
        }
    }
}

pub struct RenderDoc {
    doc: HtmlDocument,
    opts: RenderOptions,
}

impl RenderDoc {
    pub fn open(html: &str, opts: RenderOptions, net: Option<Arc<dyn NetProvider>>) -> Result<Self, OpenError> {
        if html.len() > MAX_HTML_BYTES {
            return Err(OpenError::TooLarge);
        }
        let (px_w, px_h) = tile_px(&opts);
        let config = DocumentConfig {
            viewport: Some(Viewport::new(px_w, px_h, opts.scale, ColorScheme::Light)),
            net_provider: net,
            // Without a base, blitz-dom falls back to a `data:` URL that cannot
            // resolve anything, and `resolve_url` then panics on the first relative
            // `src` / `href` / `@import`. An unresolvable http base turns every
            // relative or protocol-relative URL into an `http:` one, which the net
            // provider answers empty without queueing.
            base_url: Some(BASE_URL.to_string()),
            ..Default::default()
        };
        let mut doc = HtmlDocument::from_html(html, config);
        if doc.tree().len() > MAX_NODES {
            return Err(OpenError::TooComplex);
        }
        doc.resolve(0.0);
        Ok(Self { doc, opts })
    }

    /// Apply resources the net provider delivered since the last call, then relayout.
    pub fn apply_resources(&mut self) {
        self.doc.handle_messages();
        self.doc.resolve(0.0);
    }

    pub fn has_pending_critical(&self) -> bool {
        self.doc.has_pending_critical_resources()
    }

    /// (css_width, css_height): at least the viewport wide, clamped tall.
    fn size(&self) -> (f32, f32) {
        let layout = self.doc.root_element().final_layout();
        let css_width = (self.opts.css_width as f32).max(layout.scrollable_overflow_rect.right).max(layout.size.width);
        let css_height = layout.size.height.max(layout.scrollable_overflow_rect.bottom).min(MAX_CSS_HEIGHT);
        (css_width, css_height)
    }

    pub fn meta(&self) -> DocMeta {
        let root = self.doc.root_element();
        let (css_width, css_height) = self.size();
        let tile_count = ((css_height / TILE_CSS_HEIGHT as f32).ceil() as u32).max(1);
        DocMeta {
            css_width,
            css_height,
            tile_css_height: TILE_CSS_HEIGHT,
            tile_count,
            links: self.links(),
            plain_text: root.text_content(),
        }
    }

    /// Paint tile `index` (TILE_CSS_HEIGHT CSS px tall; the last one is shorter)
    /// as an opaque RGB PNG composited over white.
    pub fn tile_png(&mut self, index: u32) -> Vec<u8> {
        let (css_w, meta_h) = self.size();
        let css_w = css_w.ceil() as u32;
        let top = index as f32 * TILE_CSS_HEIGHT as f32;
        let css_h = (meta_h - top).clamp(1.0, TILE_CSS_HEIGHT as f32);
        let px_w = (css_w as f32 * self.opts.scale).round() as u32;
        let px_h = (css_h * self.opts.scale).round().max(1.0) as u32;
        self.doc.set_viewport_scroll(Point { x: 0.0, y: top as f64 });
        let mut painter = VelloCpuImageRenderer::new(px_w, px_h);
        let mut rgba = vec![0u8; (px_w * px_h * 4) as usize];
        let scale = self.opts.scale as f64;
        painter.render(|scene| blitz_paint::paint_scene(scene, &mut self.doc, scale, px_w, px_h, 0, 0), &mut rgba);
        encode_rgb_over_white(&rgba, px_w, px_h)
    }

    /// The `<a href>` under document point (x, y) in CSS px, if any.
    pub fn hit_link(&self, x: f32, y: f32) -> Option<LinkInfo> {
        // blitz-dom 0.3.0-beta.2 `hit` takes document coordinates (node layout
        // offsets only; the viewport scroll is not consulted and nothing is clipped
        // to the viewport), so no scroll shuffling is needed for far-down points.
        let hit = self.doc.hit(x, y)?;
        let mut id: Option<NodeId> = Some(hit.node_id);
        while let Some(n) = id {
            let node = self.doc.get_node(n)?;
            if node.data.is_element_with_tag_name(&local_name!("a")) {
                if let Some(info) = link_info(node) {
                    return Some(info);
                }
            }
            id = node.parent;
        }
        None
    }

    fn links(&self) -> Vec<LinkInfo> {
        let Ok(ids) = self.doc.query_selector_all("a[href]") else { return Vec::new() };
        ids.iter().filter_map(|id| self.doc.get_node(*id).and_then(link_info)).collect()
    }
}

fn link_info(node: &blitz_dom::Node) -> Option<LinkInfo> {
    let href = node.attr(local_name!("href"))?.trim().to_string();
    if href.is_empty() {
        return None;
    }
    Some(LinkInfo {
        href,
        text: node.text_content().trim().to_string(),
        alert: node.attr(blitz_dom::LocalName::from("data-link-alert")).map(str::to_string),
        title: node.attr(local_name!("title")).map(str::to_string),
    })
}

fn tile_px(opts: &RenderOptions) -> (u32, u32) {
    (
        (opts.css_width as f32 * opts.scale).round() as u32,
        (TILE_CSS_HEIGHT as f32 * opts.scale).round() as u32,
    )
}

/// vello_cpu writes premultiplied RGBA. Email is paper: composite over white
/// (c + (255 - a) per channel for premultiplied c) and drop alpha.
fn encode_rgb_over_white(rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for px in rgba.chunks_exact(4) {
        let inv = 255 - px[3];
        rgb.extend_from_slice(&[px[0].saturating_add(inv), px[1].saturating_add(inv), px[2].saturating_add(inv)]);
    }
    let mut out = Vec::new();
    let mut enc = png::Encoder::new(&mut out, w, h);
    enc.set_color(png::ColorType::Rgb);
    enc.set_depth(png::BitDepth::Eight);
    enc.set_compression(png::Compression::Fast);
    enc.write_header().expect("png header").write_image_data(&rgb).expect("png data");
    out
}
