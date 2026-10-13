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
//! `Box<dyn NetHandler>`. blitz-dom's call sites, however, fall into two
//! phases that we control:
//!
//! * While the HTML is parsed (`begin_parse` .. `end_parse`), blitz requests
//!   `<img src>`, `<link href>` stylesheets, `<iframe src>`, `@import` and
//!   `@font-face` urls. `https:` requests made now are held, and `end_parse`
//!   releases only the ones whose url is the resolved `src` of an `<img>` in
//!   the finished tree. Stylesheets, fonts, `@import` and frames are answered
//!   empty. The iframe never makes those requests either (its CSP has no
//!   `style-src`/`font-src` for remote hosts), so this is privacy parity.
//! * After the parse, the only thing blitz-dom fetches is a CSS image
//!   (`url()` in `background-image`, `list-style-image`, ... found while
//!   styles are flushed to layout). Those are queued directly.
use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request, Url};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// One decoded image may not exceed this many pixels (width x height).
pub const MAX_IMAGE_PIXELS: u64 = 16_000_000;
/// All images of one document together may not exceed this many pixels.
pub const MAX_DOC_IMAGE_PIXELS: u64 = 64_000_000;
/// Bytes whose header declares no size (SVG, CSS, fonts, anything unrecognised)
/// pass through only up to this length.
pub const MAX_UNSIZED_BYTES: usize = 64 * 1024;

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
    parsing: AtomicBool,
    /// `https:` requests made during the parse, decided in `end_parse`.
    held: Mutex<Vec<(String, Box<dyn NetHandler>)>>,
    outbox: Mutex<Vec<FetchRequest>>,
    pending: Mutex<HashMap<u64, (String, Box<dyn NetHandler>)>>,
}

impl BridgeNet {
    pub fn new(allow_remote: bool) -> Arc<Self> {
        Arc::new(Self {
            allow_remote,
            next: AtomicU64::new(1),
            image_pixels: AtomicU64::new(0),
            parsing: AtomicBool::new(false),
            held: Mutex::default(),
            outbox: Mutex::default(),
            pending: Mutex::default(),
        })
    }

    /// The HTML is about to be parsed: hold `https:` requests until `end_parse`.
    pub fn begin_parse(&self) {
        self.parsing.store(true, Ordering::Release);
    }

    /// The parse is done. Queue the held requests whose url is in `image_urls`
    /// (the resolved `src` of every `<img>`), answer all others empty.
    pub fn end_parse(&self, image_urls: &HashSet<String>) {
        self.parsing.store(false, Ordering::Release);
        let held = std::mem::take(&mut *self.held.lock().unwrap());
        for (url, handler) in held {
            if image_urls.contains(&url) {
                self.queue(url, handler);
            } else {
                handler.bytes(url, Bytes::new());
            }
        }
    }

    pub fn take_outbox(&self) -> Vec<FetchRequest> {
        std::mem::take(&mut *self.outbox.lock().unwrap())
    }

    /// Answer fetch `id`; `None` (denied, failed, not an image) answers it empty.
    pub fn complete(&self, id: u64, bytes: Option<Vec<u8>>) -> bool {
        let Some((url, handler)) = self.pending.lock().unwrap().remove(&id) else { return false };
        let bytes = bytes.filter(|b| self.admit(b)).unwrap_or_default();
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
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.pending.lock().unwrap().insert(id, (url.clone(), handler));
        self.outbox.lock().unwrap().push(FetchRequest { id, url });
    }

    /// May these bytes go on to a decoder? Reads only the header: an image
    /// that declares more than MAX_IMAGE_PIXELS, or would push the document
    /// past MAX_DOC_IMAGE_PIXELS, is refused before anything is decoded.
    fn admit(&self, bytes: &[u8]) -> bool {
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
                if self.parsing.load(Ordering::Acquire) {
                    self.held.lock().unwrap().push((url, handler));
                } else {
                    self.queue(url, handler);
                }
            }
            _ => handler.bytes(url, Bytes::new()),
        }
    }
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
