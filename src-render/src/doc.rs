use anyrender::ImageRenderer;
use anyrender_vello_cpu::VelloCpuImageRenderer;
use blitz_dom::{local_name, DocumentConfig, NodeId, Point};
use blitz_html::HtmlDocument;
use crate::net::{img_srcs, BridgeNet};
use blitz_traits::net::NetProvider;
use blitz_traits::shell::{ColorScheme, Viewport};
use serde::Serialize;
use std::sync::Arc;

pub const TILE_CSS_HEIGHT: u32 = 512;
pub const MAX_HTML_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_NODES: usize = 150_000;
pub const MAX_CSS_HEIGHT: f32 = 200_000.0;
/// The one source of truth for the widest document: the viewport, the reported
/// `meta.cssWidth` and every tile are clamped to it (the worker and the daemon
/// route validation use it too). 4000 CSS px at the largest scale is 16 000 px.
pub const MAX_CSS_WIDTH: f32 = 4000.0;
pub const MIN_SCALE: f32 = 0.5;
pub const MAX_SCALE: f32 = 4.0;
/// Hard cap on the pixels of one tile. The widest, sharpest legal tile is
/// MAX_CSS_WIDTH * MAX_SCALE by TILE_CSS_HEIGHT * MAX_SCALE = 32 768 000 px, so
/// a legal request always fits; anything above can only come from a bug.
pub const MAX_TILE_PIXELS: u64 = 33_554_432;
/// Deepest element nesting a document may have. Layout, text collection, hit
/// testing and paint all recurse in blitz.
pub const MAX_DEPTH: usize = 256;
/// Resolution base for relative URLs. `.invalid` is reserved (RFC 6761): it never resolves.
const BASE_URL: &str = "http://invalid.invalid/";
/// Any value at or above blitz-dom's sub-document nesting limit turns iframes off.
const NO_SUBDOCUMENTS: usize = 1000;

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

#[derive(Debug, PartialEq)]
pub enum TileError {
    /// The tile would need more pixels than MAX_TILE_PIXELS.
    TooLarge,
    /// `index` is at or past `tile_count`.
    OutOfRange,
}

impl TileError {
    pub fn code(&self) -> &'static str {
        match self {
            TileError::TooLarge => "render_too_large",
            TileError::OutOfRange => "render_tile_failed",
        }
    }
}

pub struct RenderDoc {
    doc: HtmlDocument,
    opts: RenderOptions,
}

impl RenderDoc {
    pub fn open(html: &str, opts: RenderOptions, net: Option<Arc<BridgeNet>>) -> Result<Self, OpenError> {
        if html.len() > MAX_HTML_BYTES {
            return Err(OpenError::TooLarge);
        }
        // Every element costs at least one '<': far more of them than the node
        // limit can only be refused, and counting bytes is cheaper than the
        // gigabytes a parse of 4 MiB of `<br>` costs before MAX_NODES is looked at.
        if html.bytes().filter(|&b| b == b'<').count() > 2 * MAX_NODES || nests_deeper_than_limit(html) {
            return Err(OpenError::TooComplex);
        }
        let mut opts = opts;
        opts.css_width = opts.css_width.clamp(1, MAX_CSS_WIDTH as u32);
        opts.scale = if opts.scale.is_finite() { opts.scale.clamp(MIN_SCALE, MAX_SCALE) } else { 1.0 };
        let (px_w, px_h) = tile_px(&opts);
        let config = DocumentConfig {
            viewport: Some(Viewport::new(px_w, px_h, opts.scale, ColorScheme::Light)),
            net_provider: net.clone().map(|n| n as Arc<dyn NetProvider>),
            // Without a base, blitz-dom falls back to a `data:` URL that cannot
            // resolve anything, and `resolve_url` then panics on the first relative
            // `src` / `href` / `@import`. An unresolvable http base turns every
            // relative or protocol-relative URL into an `http:` one, which the net
            // provider answers empty without queueing.
            base_url: Some(BASE_URL.to_string()),
            // blitz-dom loads an <iframe> only below its own nesting limit (10).
            // Sub-documents have no place in a mail reader: they parse outside
            // the node and depth checks, and fetch on their own.
            subdocument_depth: NO_SUBDOCUMENTS,
            ..Default::default()
        };
        if let Some(n) = &net {
            n.begin_parse();
        }
        let mut doc = HtmlDocument::from_html(html, config);
        if doc.tree().len() > MAX_NODES || exceeds_depth(&doc) {
            return Err(OpenError::TooComplex);
        }
        if let Some(n) = &net {
            // Everything blitz asked for while parsing is decided now: images are
            // queued, stylesheets, fonts, @import and frames are answered empty.
            n.end_parse(&img_srcs(&doc));
        }
        doc.handle_messages();
        doc.resolve(0.0);
        Ok(Self { doc, opts })
    }

    /// Apply resources the net provider delivered since the last call, then relayout.
    pub fn apply_resources(&mut self) {
        self.doc.handle_messages();
        self.doc.resolve(0.0);
    }

    /// How many <iframe> sub-documents were loaded (always 0: they are switched off).
    pub fn subdocument_count(&self) -> usize {
        self.doc.sub_document_node_ids().len()
    }

    pub fn has_pending_critical(&self) -> bool {
        self.doc.has_pending_critical_resources()
    }

    /// (css_width, css_height): at least the viewport wide, clamped tall.
    fn size(&self) -> (f32, f32) {
        let layout = self.doc.root_element().final_layout();
        let css_width = (self.opts.css_width as f32)
            .max(layout.scrollable_overflow_rect.right)
            .max(layout.size.width)
            .min(MAX_CSS_WIDTH);
        let css_height = layout.size.height.max(layout.scrollable_overflow_rect.bottom).min(MAX_CSS_HEIGHT);
        (css_width, css_height)
    }

    pub fn meta(&self) -> DocMeta {
        let root = self.doc.root_element();
        let (css_width, css_height) = self.size();
        let tile_count = tile_count(css_height);
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
    pub fn tile_png(&mut self, index: u32) -> Result<Vec<u8>, TileError> {
        let (css_w, meta_h) = self.size();
        let (px_w, px_h) = tile_dims(css_w, meta_h, index, self.opts.scale)?;
        let top = index as f64 * TILE_CSS_HEIGHT as f64;
        self.doc.set_viewport_scroll(Point { x: 0.0, y: top });
        let mut painter = VelloCpuImageRenderer::new(px_w, px_h);
        let mut rgba = vec![0u8; px_w as usize * px_h as usize * 4];
        let scale = self.opts.scale as f64;
        painter.render(|scene| blitz_paint::paint_scene(scene, &mut self.doc, scale, px_w, px_h, 0, 0), &mut rgba);
        Ok(encode_rgb_over_white(&rgba, px_w, px_h))
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

/// Number of TILE_CSS_HEIGHT-tall tiles for a document `doc_h` CSS px tall.
fn tile_count(doc_h: f32) -> u32 {
    ((doc_h / TILE_CSS_HEIGHT as f32).ceil() as u32).max(1)
}

/// Device-pixel size of tile `index` of a `css_w` x `doc_h` document at `scale`.
/// The arithmetic is u64 and checked, so no input can wrap or truncate it.
pub fn tile_dims(css_w: f32, doc_h: f32, index: u32, scale: f32) -> Result<(u32, u32), TileError> {
    if index >= tile_count(doc_h) {
        return Err(TileError::OutOfRange);
    }
    let top = index as f64 * TILE_CSS_HEIGHT as f64;
    let css_h = (doc_h as f64 - top).clamp(1.0, TILE_CSS_HEIGHT as f64);
    let px_w = (css_w.ceil() as f64 * scale as f64).round() as u64;
    let px_h = ((css_h * scale as f64).round() as u64).max(1);
    // vello_cpu takes u16 dimensions: a larger width would truncate.
    let fits = px_w >= 1 && px_w <= u16::MAX as u64 && px_h <= u16::MAX as u64;
    match px_w.checked_mul(px_h) {
        Some(px) if fits && px <= MAX_TILE_PIXELS => Ok((px_w as u32, px_h as u32)),
        _ => Err(TileError::TooLarge),
    }
}

/// Cheap pre-parse guard against nesting bombs. The HTML parser takes time
/// that grows faster than linearly with depth (100 000 nested `<div>` ran for
/// many minutes), so waiting for the post-parse depth check is too late. Only
/// elements that nothing closes implicitly are counted (a `<p>` or `<td>` does
/// not nest), so for them open minus close is the real depth; markup that is
/// deeper than MAX_DEPTH by this count is deeper in the parsed tree too.
fn nests_deeper_than_limit(html: &str) -> bool {
    const NESTING: [&[u8]; 7] = [b"div", b"span", b"table", b"blockquote", b"font", b"center", b"section"];
    let bytes = html.as_bytes();
    let (mut depth, mut i) = (0usize, 0usize);
    while let Some(off) = bytes[i..].iter().position(|&b| b == b'<') {
        i += off + 1;
        let closing = bytes.get(i) == Some(&b'/');
        let start = i + closing as usize;
        let len = bytes[start..].iter().take_while(|b| b.is_ascii_alphanumeric()).count();
        let name = &bytes[start..start + len];
        if NESTING.iter().any(|n| name.eq_ignore_ascii_case(n)) {
            if closing {
                depth = depth.saturating_sub(1);
            } else {
                depth += 1;
                if depth > MAX_DEPTH {
                    return true;
                }
            }
        }
    }
    false
}

/// True when any element nests deeper than MAX_DEPTH. Iterative on purpose:
/// this runs on input that would overflow a recursive walk.
fn exceeds_depth(doc: &HtmlDocument) -> bool {
    let mut stack = vec![(doc.root_node().id, 1usize)];
    while let Some((id, depth)) = stack.pop() {
        if depth > MAX_DEPTH {
            return true;
        }
        if let Some(node) = doc.get_node(id) {
            stack.extend(node.children.iter().map(|c| (*c, depth + 1)));
        }
    }
    false
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
    let mut rgb = Vec::with_capacity(w as usize * h as usize * 3);
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
