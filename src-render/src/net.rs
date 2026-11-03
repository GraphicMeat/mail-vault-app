//! The worker's only door to resources. `data:` decodes here; `https:` is
//! queued for the daemon to fetch (SSRF guard, image-only, Network Activity)
//! but ONLY for images; everything else is answered empty at once. Every
//! request is answered exactly once: an unanswered stylesheet keeps the
//! document's critical set non-empty and Blitz then never paints.
//!
//! Which `https:` requests are images
//! ----------------------------------
//! blitz-traits 0.3.0-beta.2 gives no way to tell: `Request` is a bare GET
//! (url, method, empty headers, no content type) and the handler is an opaque
//! `Box<dyn NetHandler>`. So the kind is inferred from WHEN blitz-dom asks,
//! which this crate controls, and the default is deny:
//!
//! * Every `https:` request is HELD. It is queued for the daemon only by
//!   `settle`, and only if its url is the resolved `src` of an `<img>` in the
//!   parsed tree. Stylesheets, fonts, `@import`, frames and anything else are
//!   answered empty. The iframe never makes those requests either (its CSP
//!   has no `style-src`/`font-src` for remote hosts), so this is privacy parity.
//!   Requests are made while parsing, but also later: a `data:` stylesheet is
//!   applied by `handle_messages` and only then requests its `@font-face`.
//! * The one exception is the window `begin_layout` .. `end_layout`, which the
//!   caller opens around `resolve()` only. The only thing blitz-dom fetches
//!   there is a CSS image (`url()` in `background-image` and friends, found while
//!   styles are flushed to layout), so those are queued directly.
//!
//! This classification depends on blitz-dom 0.3.0-beta.2's call sites. The
//! tests in `tests/net.rs` pin every kind; re-run them on any blitz bump.
use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request, Url};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// One image may be painted at no more than this many pixels (width x height). A
/// bigger one is not refused: it is decoded once and shrunk to fit (`shrink`).
pub const MAX_IMAGE_PIXELS: u64 = 16_000_000;
/// The largest image that is decoded to be shrunk: a 25 MB JPEG reaches about 150 MP. Above it
/// the header alone decides: refused, nothing decoded. The transient decode is the
/// most memory the worker ever spends on one image (`MAX_DECODE_ALLOC`).
pub const MAX_DECODE_PIXELS: u64 = 150_000_000;
const MAX_DECODE_ALLOC: u64 = 5 * MAX_DECODE_PIXELS + (1 << 20);
/// The largest picture file that is shown (the usual mail attachment limit). A picture's
/// bytes are checked before its header: over this it is refused, whatever its pixels.
pub const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
/// What is left of the document's budget is not worth a decode below this.
const MIN_SHRUNK_PIXELS: u64 = 250_000;
/// All images of one document together may not exceed this many pixels.
pub const MAX_DOC_IMAGE_PIXELS: u64 = 64_000_000;
/// Bytes whose header declares no size (CSS, fonts, anything unrecognised; gzip
/// never passes, see `is_gzip`) pass through only up to this length.
pub const MAX_UNSIZED_BYTES: usize = 64 * 1024;
/// SVG markup declares no pixel size either, but real artwork is larger than CSS or
/// a font hint: it passes up to this length. Whatever it embeds is capped by the
/// SVG href resolver in the vendored blitz-dom (`parse_svg_image`).
pub const MAX_SVG_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct FetchRequest {
    pub id: u64,
    pub url: String,
}

pub struct BridgeNet {
    allow_remote: bool,
    next: AtomicU64,
    /// Pixels already admitted for this document (see MAX_DOC_IMAGE_PIXELS).
    image_pixels: AtomicU64,
    /// True only while the caller is inside `resolve()`: see the module comment.
    layout: AtomicBool,
    /// `https:` requests not yet decided; `settle` or `deny_held` answers them.
    held: Mutex<Vec<(String, Box<dyn NetHandler>)>>,
    outbox: Mutex<Vec<FetchRequest>>,
    pending: Mutex<HashMap<u64, (String, Box<dyn NetHandler>)>>,
    /// Bytes every answered https fetch delivered, by URL: a rebuild (fonts op)
    /// answers from here instead of fetching again through Network Activity.
    cache: Mutex<HashMap<String, Vec<u8>>>,
    /// Pictures refused for size, by `url_key`, with the width and height their
    /// header declares: the reader offers to open those at full size instead.
    refused: Mutex<HashMap<u64, (u32, u32)>>,
}

/// A stand-in for a url in `BridgeNet::refused`: a `data:` url of a photo is
/// tens of MB, and the map only has to answer "was this one refused".
fn url_key(url: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut h);
    h.finish()
}

impl BridgeNet {
    pub fn new(allow_remote: bool) -> Arc<Self> {
        Self::with_cache(allow_remote, HashMap::new())
    }

    /// A provider that already holds the bytes of earlier fetches: a request
    /// for one of those urls is answered at once and never queued.
    pub fn with_cache(allow_remote: bool, cache: HashMap<String, Vec<u8>>) -> Arc<Self> {
        Arc::new(Self {
            allow_remote,
            next: AtomicU64::new(1),
            image_pixels: AtomicU64::new(0),
            layout: AtomicBool::new(false),
            held: Mutex::default(),
            outbox: Mutex::default(),
            pending: Mutex::default(),
            cache: Mutex::new(cache),
            refused: Mutex::default(),
        })
    }

    /// Number this provider's fetches after `prev`'s, so a late answer to one
    /// of `prev`'s in-flight fetches can never complete one of ours.
    pub fn continue_ids_after(&self, prev: &BridgeNet) {
        self.next.store(prev.next.load(Ordering::Relaxed), Ordering::Relaxed);
    }

    /// What the answered https fetches delivered (admitted bytes only), by URL.
    pub fn cache(&self) -> HashMap<String, Vec<u8>> {
        self.cache.lock().unwrap().clone()
    }

    /// The declared (width, height) of the picture at `url` if it was refused for
    /// size: over the file limit, past what can be decoded, or with no room left in
    /// the document's pixel budget. Not for a fetch that failed, gzip, or bytes that
    /// are no picture.
    pub fn refused(&self, url: &str) -> Option<(u32, u32)> {
        self.refused.lock().unwrap().get(&url_key(url)).copied()
    }

    pub fn has_refused(&self) -> bool {
        !self.refused.lock().unwrap().is_empty()
    }

    /// The caller is about to run `resolve()`: https requests made now are CSS images.
    pub fn begin_layout(&self) {
        self.layout.store(true, Ordering::Release);
    }

    pub fn end_layout(&self) {
        self.layout.store(false, Ordering::Release);
    }

    pub fn has_held(&self) -> bool {
        !self.held.lock().unwrap().is_empty()
    }

    /// Decide every held request: queue the ones whose url is in `image_urls`
    /// (the resolved `src` of every `<img>`), answer all others empty.
    pub fn settle(&self, image_urls: &HashSet<String>) {
        let held = std::mem::take(&mut *self.held.lock().unwrap());
        for (url, handler) in held {
            if image_urls.contains(&url) {
                self.queue(url, handler);
            } else {
                handler.bytes(url, Bytes::new());
            }
        }
    }

    /// Answer every held request empty without queueing any.
    pub fn deny_held(&self) {
        self.settle(&HashSet::new());
    }

    pub fn take_outbox(&self) -> Vec<FetchRequest> {
        std::mem::take(&mut *self.outbox.lock().unwrap())
    }

    /// Answer fetch `id`; `None` (denied, failed, not an image) answers it empty.
    pub fn complete(&self, id: u64, bytes: Option<Vec<u8>>) -> bool {
        let Some((url, handler)) = self.pending.lock().unwrap().remove(&id) else { return false };
        let bytes = bytes.map(|b| self.admit(&url, b)).unwrap_or_default();
        if !bytes.is_empty() {
            self.cache.lock().unwrap().insert(url.clone(), bytes.clone());
        }
        handler.bytes(url, Bytes::from(bytes));
        true
    }

    /// Answer every outstanding request empty (doc closing, worker shutting down).
    pub fn fail_all(&self) {
        let drained: Vec<_> = self.pending.lock().unwrap().drain().collect();
        let held = std::mem::take(&mut *self.held.lock().unwrap());
        for (url, handler) in drained.into_iter().map(|(_, v)| v).chain(held) {
            handler.bytes(url, Bytes::new());
        }
        self.outbox.lock().unwrap().clear();
    }

    fn queue(&self, url: String, handler: Box<dyn NetHandler>) {
        // Only urls that were admitted as images are cached, and `queue` is
        // reached only for images, so the cache sits behind the same gate.
        let cached = self.cache.lock().unwrap().get(&url).cloned();
        if let Some(bytes) = cached {
            // Counted against this document's pixel budget like a fresh answer.
            handler.bytes(url.clone(), Bytes::from(self.admit(&url, bytes)));
            return;
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.pending.lock().unwrap().insert(id, (url.clone(), handler));
        self.outbox.lock().unwrap().push(FetchRequest { id, url });
    }

    /// The bytes to hand a decoder: the image as it came, shrunk to what its
    /// per-image and the document's pixel budget allow, or empty (refused).
    /// Only the header is read first: nothing past MAX_DECODE_PIXELS, and nothing
    /// that no longer fits the document's budget, is ever decoded.
    /// gzip is refused outright, whatever the URL or declared type said: see
    /// `is_gzip`. SVG markup is admitted up to MAX_SVG_BYTES.
    fn admit(&self, url: &str, bytes: Vec<u8>) -> Vec<u8> {
        if is_gzip(&bytes) {
            return Vec::new();
        }
        let size = imagesize::blob_size(&bytes).ok();
        if bytes.len() > MAX_IMAGE_BYTES {
            self.refuse(url, size);
            return Vec::new();
        }
        let ok = match size {
            Some(size) => {
                let px = (size.width as u64).saturating_mul(size.height as u64);
                let room = MAX_DOC_IMAGE_PIXELS.saturating_sub(self.image_pixels.load(Ordering::Acquire));
                let fit = MAX_IMAGE_PIXELS.min(room);
                let admitted = if px <= fit {
                    self.spend(px).then_some(bytes)
                } else if px > MAX_DECODE_PIXELS || fit < MIN_SHRUNK_PIXELS {
                    None
                } else {
                    shrink(&bytes, fit).filter(|(_, small_px)| self.spend(*small_px)).map(|(small, _)| small)
                };
                if admitted.is_none() {
                    self.refuse(url, Some(size));
                }
                return admitted.unwrap_or_default();
            }
            None if looks_like_svg(&bytes) => bytes.len() <= MAX_SVG_BYTES,
            None => bytes.len() <= MAX_UNSIZED_BYTES,
        };
        if ok { bytes } else { Vec::new() }
    }

    /// Remember that the picture at `url` was refused for size, if its header says
    /// what it is: bytes that are no picture have nothing to open.
    fn refuse(&self, url: &str, size: Option<imagesize::ImageSize>) {
        if let Some(size) = size {
            self.refused.lock().unwrap().insert(url_key(url), (size.width as u32, size.height as u32));
        }
    }

    /// Take `px` from the document's pixel budget, or leave it as it was.
    fn spend(&self, px: u64) -> bool {
        self.image_pixels
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(px).filter(|total| *total <= MAX_DOC_IMAGE_PIXELS)
            })
            .is_ok()
    }
}

/// `bytes` decoded once and scaled down, aspect ratio kept, to at most `max_px`
/// pixels, as `(encoded image, its pixels)`. JPEG stays JPEG, anything with alpha
/// goes out as PNG. None when it cannot be decoded: it is then refused like any
/// other bytes that are not an image.
fn shrink(bytes: &[u8], max_px: u64) -> Option<(Vec<u8>, u64)> {
    use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, ImageFormat, ImageReader, Limits};
    let format = image::guess_format(bytes).ok().filter(|f| matches!(f, ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP))?;
    let mut reader = ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    reader.limits(limits);
    let img = reader.decode().ok()?;
    let (w, h) = (img.width() as u64, img.height() as u64);
    let scale = (max_px as f64 / (w * h) as f64).sqrt();
    let mut nw = ((w as f64 * scale).floor() as u64).max(1);
    let mut nh = ((h as f64 * scale).floor() as u64).max(1);
    while nw * nh > max_px {
        if nw >= nh { nw -= 1 } else { nh -= 1 }
    }
    let small = img.resize_exact(nw as u32, nh as u32, FilterType::Triangle);
    let mut out = Vec::new();
    if format == ImageFormat::Jpeg || !small.color().has_alpha() {
        let rgb = small.to_rgb8();
        JpegEncoder::new_with_quality(&mut out, 90).encode_image(&rgb).ok()?;
    } else {
        small.write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png).ok()?;
    }
    Some((out, nw * nh))
}

impl NetProvider for BridgeNet {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        let url = request.url.to_string();
        match request.url.scheme() {
            "data" => {
                let bytes = data_url::DataUrl::process(&url)
                    .ok()
                    .and_then(|d| d.decode_to_vec().ok())
                    .map(|(body, _)| self.admit(&url, body))
                    .unwrap_or_default();
                handler.bytes(url, Bytes::from(bytes));
            }
            "https" if self.allow_remote => {
                if self.layout.load(Ordering::Acquire) {
                    self.queue(url, handler);
                } else {
                    self.held.lock().unwrap().push((url, handler));
                }
            }
            _ => handler.bytes(url, Bytes::new()),
        }
    }
}

/// Is this a gzip stream? blitz-dom's image handler tries the raster decoders and
/// then falls back to usvg for anything they reject, and usvg inflates gzip (svgz)
/// before parsing, with no cap on the inflated size. Refused whatever the URL or
/// the declared type said. (Plain SVG is fine: the vendored blitz-dom parses it
/// with a resolver that cannot read a file or a url, see `parse_svg_image`.)
fn is_gzip(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x1f, 0x8b])
}

/// Markup that mentions `svg`: an XML prolog, a comment, a doctype, a BOM,
/// whitespace or a namespace prefix may all come before the root element. Raster
/// formats begin with binary magic, never `<`.
fn looks_like_svg(bytes: &[u8]) -> bool {
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(bytes);
    let body = &body[body.iter().position(|b| !b.is_ascii_whitespace()).unwrap_or(body.len())..];
    body.first() == Some(&b'<') && body.windows(3).any(|w| w.eq_ignore_ascii_case(b"svg"))
}

/// The resolved `src` of every `<img>`: the urls blitz fetches as images while parsing.
pub(crate) fn img_srcs(doc: &blitz_dom::BaseDocument) -> HashSet<String> {
    use blitz_dom::local_name;
    let base: &Url = doc.base_url();
    doc.tree()
        .iter()
        .filter_map(|(_, node)| {
            if !node.data.is_element_with_tag_name(&local_name!("img")) {
                return None;
            }
            base.join(node.attr(local_name!("src"))?).ok().map(|u| u.to_string())
        })
        .collect()
}
