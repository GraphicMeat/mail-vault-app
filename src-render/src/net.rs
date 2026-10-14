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

/// One decoded image may not exceed this many pixels (width x height).
pub const MAX_IMAGE_PIXELS: u64 = 16_000_000;
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
        let bytes = bytes.filter(|b| self.admit(b)).unwrap_or_default();
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
            let bytes = if self.admit(&bytes) { bytes } else { Vec::new() };
            handler.bytes(url, Bytes::from(bytes));
            return;
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.pending.lock().unwrap().insert(id, (url.clone(), handler));
        self.outbox.lock().unwrap().push(FetchRequest { id, url });
    }

    /// May these bytes go on to a decoder? Reads only the header: an image
    /// that declares more than MAX_IMAGE_PIXELS, or would push the document
    /// past MAX_DOC_IMAGE_PIXELS, is refused before anything is decoded.
    /// gzip is refused outright, whatever the URL or declared type said: see
    /// `is_gzip`. SVG markup is admitted up to MAX_SVG_BYTES.
    fn admit(&self, bytes: &[u8]) -> bool {
        if is_gzip(bytes) {
            return false;
        }
        match imagesize::blob_size(bytes) {
            Ok(size) => {
                let px = (size.width as u64).saturating_mul(size.height as u64);
                if px > MAX_IMAGE_PIXELS {
                    return false;
                }
                self.image_pixels
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                        used.checked_add(px).filter(|total| *total <= MAX_DOC_IMAGE_PIXELS)
                    })
                    .is_ok()
            }
            Err(_) if looks_like_svg(bytes) => bytes.len() <= MAX_SVG_BYTES,
            Err(_) => bytes.len() <= MAX_UNSIZED_BYTES,
        }
    }
}

impl NetProvider for BridgeNet {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        let url = request.url.to_string();
        match request.url.scheme() {
            "data" => {
                let bytes = data_url::DataUrl::process(&url)
                    .ok()
                    .and_then(|d| d.decode_to_vec().ok())
                    .map(|(body, _)| body)
                    .filter(|body| self.admit(body))
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
pub(crate) fn img_srcs(doc: &blitz_html::HtmlDocument) -> HashSet<String> {
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
