use blitz_dom::{local_name, BaseDocument, DocumentConfig, FontContext, NodeId, Point};
use blitz_html::HtmlDocument;
use crate::net::{img_srcs, BridgeNet};
use blitz_traits::net::NetProvider;
use blitz_traits::shell::{ColorScheme, Viewport};
use serde::Serialize;
use std::cell::RefCell;
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
    /// Dark Reader settings; None renders light (plan B).
    pub dark: Option<crate::dark::DarkTheme>,
    /// Paint on a clear canvas and encode RGBA, not RGB over white: the
    /// surfaces that composite the mail themselves (plan D). Default false.
    pub transparent: bool,
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
    pub folds: Vec<crate::fold::FoldInfo>,
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
    net: Option<Arc<BridgeNet>>,
    /// Text runs of the whole document with each run's tile, computed once per
    /// layout (see `text_runs`).
    runs: RefCell<Option<crate::text::TiledRuns>>,
}

/// Rounds of "decide held requests, apply the answers" before the rest are
/// simply denied. A stylesheet that imports a stylesheet that imports ... is
/// answered empty at the first hop, so more than a couple of rounds only
/// happens for data: chains.
const SETTLE_ROUNDS: usize = 4;

/// Decide every held request and ingest what the net provider delivered, with
/// the CSS-image window still closed (see the module comment in `net.rs`): a
/// `data:` stylesheet answered during the parse is applied here, and whatever
/// `@font-face` / `@import` it then requests is denied, never queued.
fn settle_all(doc: &mut BaseDocument, net: &Arc<BridgeNet>) {
    for _ in 0..SETTLE_ROUNDS {
        if !net.has_held() {
            break;
        }
        net.settle(&img_srcs(doc));
        doc.handle_messages();
    }
    net.deny_held();
    doc.handle_messages();
}

/// Apply what the net provider delivered, deciding every held request first
/// (see the module comment in `net.rs`), then relayout with the layout window
/// open so CSS images are queued.
fn apply(doc: &mut HtmlDocument, net: Option<&Arc<BridgeNet>>) {
    if let Some(n) = net {
        settle_all(doc, n);
        n.begin_layout();
        doc.resolve(0.0);
        n.end_layout();
    } else {
        doc.handle_messages();
        doc.resolve(0.0);
    }
}

impl RenderDoc {
    pub fn open(html: &str, opts: RenderOptions, net: Option<Arc<BridgeNet>>) -> Result<Self, OpenError> {
        Self::open_with(html, opts, net, crate::fonts::FontLibrary::new(true).context())
    }

    /// `open` with the caller's fonts: blitz-dom keeps a document's font context
    /// private, so the worker hands each document a clone of its master one.
    pub fn open_with(html: &str, opts: RenderOptions, net: Option<Arc<BridgeNet>>, fonts: FontContext) -> Result<Self, OpenError> {
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
            font_ctx: Some(fonts),
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
        let html = crate::compat::word_break_break_word(html);
        let mut doc = HtmlDocument::from_html(&html, config);
        if doc.tree().len() > MAX_NODES || exceeds_depth(&doc) {
            return Err(OpenError::TooComplex);
        }
        // Before anything can lay the document out (Dark Reader measures SVG boxes).
        strip_svg_references(&mut doc);
        match &opts.dark {
            Some(theme) => crate::dark::apply(&mut doc, theme, &mut |d| {
                // Same order as `apply`: decide held requests and ingest data: sheets
                // BEFORE the layout window opens, so their fonts and imports are
                // denied; CSS images found by the layout itself are queued.
                if let Some(n) = &net {
                    settle_all(d, n);
                    n.begin_layout();
                }
                d.resolve(0.0);
                if let Some(n) = &net {
                    n.end_layout();
                }
            }),
            None => crate::styles::rewrite(&mut doc, |_, _| crate::styles::Rewrite::default()),
        }
        // Everything blitz asked for while parsing is decided here: images are
        // queued, stylesheets, fonts, @import and frames are answered empty.
        apply(&mut doc, net.as_ref());
        crate::fold::apply_toggle_theme(&mut doc);
        Ok(Self { doc, opts, net, runs: RefCell::new(None) })
    }

    /// Apply resources the net provider delivered since the last call, then relayout.
    pub fn apply_resources(&mut self) {
        apply(&mut self.doc, self.net.as_ref());
        self.invalidate_runs();
    }

    /// The text runs of every root segment whose first line's top falls in tile
    /// `index`, all of its lines included (see `text::TiledRuns`). The whole
    /// document is walked once per layout and cached, then filtered by tile: a
    /// select-all asks for every tile, and a layout walk each would hold the
    /// worker for hundreds of passes.
    pub fn text_runs(&self, index: u32) -> Vec<crate::text::TextRun> {
        self.with_runs(|t| t.runs_of(index))
    }

    /// The tiles, other than `index`, that own a segment with a line in tile
    /// `index`: a layer that shows only this tile must load them too.
    pub fn text_owners(&self, index: u32) -> Vec<u32> {
        self.with_runs(|t| t.owners_of(index))
    }

    fn with_runs<T>(&self, f: impl FnOnce(&crate::text::TiledRuns) -> T) -> T {
        let mut cache = self.runs.borrow_mut();
        f(cache.get_or_insert_with(|| crate::text::TiledRuns::new(crate::text::all_runs(&self.doc))))
    }

    /// Rich and plain copy of the selection between two layout endpoints (see
    /// `serialize`). Reversed endpoints are swapped. Read-only: it never
    /// touches blitz's selection, so no tile ever paints a highlight.
    pub fn serialize(&self, a: crate::serialize::Endpoint, b: crate::serialize::Endpoint) -> crate::serialize::Serialized {
        crate::serialize::serialize(&self.doc, a, b)
    }

    /// For tests: the underlying blitz document.
    pub fn base(&self) -> &blitz_dom::BaseDocument {
        &self.doc
    }

    /// Any relayout makes the cached runs wrong.
    fn invalidate_runs(&self) {
        *self.runs.borrow_mut() = None;
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
            folds: crate::fold::read_folds(&self.doc),
        }
    }

    /// Tile `index` (TILE_CSS_HEIGHT CSS px tall; the last one is shorter) as
    /// premultiplied RGBA at the doc's scale: (pixels, width, height).
    fn tile_rgba(&mut self, index: u32) -> Result<(Vec<u8>, u32, u32), TileError> {
        let (css_w, meta_h) = self.size();
        let (px_w, px_h) = tile_dims(css_w, meta_h, index, self.opts.scale)?;
        let top = index as f64 * TILE_CSS_HEIGHT as f64;
        self.doc.set_viewport_scroll(Point { x: 0.0, y: top });
        // A full tile's height, so the last tile shares its renderer; not past the pixel cap.
        let full_h = ((TILE_CSS_HEIGHT as f64 * self.opts.scale as f64).round() as u32).max(px_h);
        let full_h = if px_w as u64 * full_h as u64 <= MAX_TILE_PIXELS { full_h } else { px_h };
        let rgba = crate::raster::paint(&mut self.doc, self.opts.scale as f64, px_w, px_h, full_h);
        Ok((rgba, px_w, px_h))
    }

    /// Paint tile `index` as a PNG: opaque RGB composited over white, or RGBA
    /// with straight alpha when the doc was opened `transparent`.
    pub fn tile_png(&mut self, index: u32) -> Result<Vec<u8>, TileError> {
        let (rgba, w, h) = self.tile_rgba(index)?;
        Ok(self.encode(&rgba, w, h))
    }

    /// The whole document as one PNG, at `doc_image::image_scale` of the doc
    /// scale: the tiles painted as for `tile_png`, box-downscaled when the area
    /// cap demands it, stacked. A document clamped at MAX_CSS_HEIGHT is the
    /// clamped height; the caller decides what to do about that.
    pub fn image_png(&mut self) -> Result<Vec<u8>, TileError> {
        let (css_w, css_h) = self.size();
        let scale = self.opts.scale as f64;
        let s = crate::doc_image::image_scale(css_w.ceil() as f64, css_h as f64, scale);
        let factor = s / scale;
        let tiles = tile_count(css_h);
        // The final size, to the pixel row: every tile but the last is a full one.
        let expected = (css_w.ceil() as f64 * s * css_h as f64 * s * 4.0).ceil() as usize;
        let (mut all, mut width, mut height) = (Vec::with_capacity(expected), 0u32, 0u32);
        for i in 0..tiles {
            let (rgba, w, h) = self.tile_rgba(i)?;
            let (px, dw, dh) = if factor < 1.0 { crate::doc_image::downscale_rgba(&rgba, w, h, factor) } else { (rgba, w, h) };
            if width == 0 {
                width = dw;
            }
            // Every tile has the same width; the pad is only a guard against a stride mismatch.
            let used = dw.min(width);
            for row in 0..dh {
                let start = row as usize * dw as usize * 4;
                all.extend_from_slice(&px[start..start + used as usize * 4]);
                all.resize(all.len() + (width - used) as usize * 4, 0);
            }
            height += dh;
        }
        Ok(self.encode(&all, width, height))
    }

    fn encode(&self, rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
        if self.opts.transparent {
            encode_rgba_straight(rgba, w, h)
        } else {
            encode_rgb_over_white(rgba, w, h)
        }
    }

    /// Parity measurements for every `[data-mv-id]` element (see inspect.rs).
    pub fn inspect(&mut self) -> Vec<crate::inspect::InspectedElement> {
        crate::inspect::reset_scroll(&mut self.doc);
        crate::inspect::collect(&self.doc)
    }

    /// Open or close fold `id` and relayout once, the same way a resource
    /// arrival does (so CSS images in a region that was display:none are
    /// queued). False, and nothing touched, for an unknown id or a fold
    /// already in that state.
    pub fn set_fold(&mut self, id: &str, open: bool) -> bool {
        let changed = crate::fold::set_fold(&mut self.doc, id, open);
        if changed {
            self.apply_resources(); // also drops the cached text runs
        }
        changed
    }

    /// Link and fold under document point (x, y) in CSS px.
    pub fn hit(&self, x: f32, y: f32) -> (Option<LinkInfo>, Option<String>) {
        // blitz-dom 0.3.0-beta.2 `hit` takes document coordinates (node layout
        // offsets only; the viewport scroll is not consulted and nothing is clipped
        // to the viewport), so no scroll shuffling is needed for far-down points.
        let Some(hit) = self.doc.hit(x, y) else { return (None, None) };
        (self.link_from(hit.node_id), crate::fold::fold_at(&self.doc, hit.node_id))
    }

    /// The `<a href>` under document point (x, y) in CSS px, if any.
    pub fn hit_link(&self, x: f32, y: f32) -> Option<LinkInfo> {
        self.hit(x, y).0
    }

    /// The nearest `<a href>` at or above `id`.
    fn link_from(&self, id: NodeId) -> Option<LinkInfo> {
        let mut id: Option<NodeId> = Some(id);
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

    #[doc(hidden)]
    pub fn text_runs_all_including_noselect_for_test(&self) -> Vec<String> {
        crate::text::inline_roots(&self.doc)
            .into_iter()
            .filter_map(|id| self.doc.get_node(id)?.element_data()?.inline_layout_data.as_deref().map(|t| t.text.clone()))
            .collect()
    }

    #[doc(hidden)]
    pub fn inspect_toggle_colors_for_test(&mut self, id: &str) -> (String, String) {
        crate::fold::toggle_colors(&self.doc, id)
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

const SVG_NS: &str = "http://www.w3.org/2000/svg";

/// Make inline SVG unable to name a resource, as a second line behind the href
/// resolver of the vendored blitz-dom (`parse_svg_image`), which already answers no
/// non-`data:` href. Runs after parsing and before layout, the moment blitz-dom
/// serialises each `<svg>` for usvg. It removes every `image` and `feImage` element
/// whose `href` / `xlink:href` is not a `data:` url or an in-document `#id`
/// reference (`data:` rasters paint, within the resolver's pixel caps), and removes
/// every `href` / `xlink:href` on any other SVG element that is not a `#id`
/// reference. Flat pass over the node slab: no recursion, whatever the nesting.
/// (The HTML parser turns `<image>` outside SVG into `<img>`, which goes through
/// `BridgeNet` like any other image.)
fn strip_svg_references(doc: &mut HtmlDocument) {
    let ids: Vec<NodeId> = doc.tree().iter().map(|(id, _)| id).collect();
    let mut images = Vec::new();
    for id in ids {
        let Some(el) = doc.get_node_mut(id).and_then(|n| n.element_data_mut()) else { continue };
        let tag: &str = &el.name.local;
        if tag.eq_ignore_ascii_case("image") || tag.eq_ignore_ascii_case("feimage") {
            if el.attrs.iter().any(|a| &*a.name.local == "href" && !is_data_or_fragment(&a.value)) {
                images.push(id);
            }
        } else if &*el.name.ns == SVG_NS {
            el.attrs.retain(|a| &*a.name.local != "href" || a.value.starts_with('#'));
        }
    }
    if !images.is_empty() {
        let mut edit = doc.mutate();
        for id in images {
            // An image inside an image went with its parent.
            if edit.doc.get_node(id).is_some() {
                edit.remove_and_drop_node(id);
            }
        }
    }
}

/// `data:` (any case, no leading space: a url usvg would trim is refused here, the safe side) or `#id`.
fn is_data_or_fragment(href: &str) -> bool {
    href.starts_with('#') || href.get(..5).is_some_and(|p| p.eq_ignore_ascii_case("data:"))
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

/// vello_cpu writes premultiplied RGBA; PNG wants straight alpha.
fn encode_rgba_straight(rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
    let mut px = Vec::with_capacity(rgba.len());
    for p in rgba.chunks_exact(4) {
        let a = p[3] as u32;
        if a == 0 {
            px.extend_from_slice(&[0, 0, 0, 0]);
            continue;
        }
        let un = |c: u8| ((c as u32 * 255 + a / 2) / a).min(255) as u8;
        px.extend_from_slice(&[un(p[0]), un(p[1]), un(p[2]), p[3]]);
    }
    let mut out = Vec::new();
    let mut enc = png::Encoder::new(&mut out, w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.set_compression(png::Compression::Fast);
    enc.write_header().expect("png header").write_image_data(&px).expect("png data");
    out
}
