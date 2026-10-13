//! The worker's only door to resources. `data:` decodes here; `https:` is
//! queued for the daemon to fetch (SSRF guard, image-only, Network Activity);
//! everything else is answered empty at once. Every request is answered
//! exactly once: an unanswered stylesheet keeps the document's critical set
//! non-empty and Blitz then never paints.
use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, PartialEq)]
pub struct FetchRequest {
    pub id: u64,
    pub url: String,
}

pub struct BridgeNet {
    allow_remote: bool,
    next: AtomicU64,
    outbox: Mutex<Vec<FetchRequest>>,
    pending: Mutex<HashMap<u64, (String, Box<dyn NetHandler>)>>,
}

impl BridgeNet {
    pub fn new(allow_remote: bool) -> Arc<Self> {
        Arc::new(Self { allow_remote, next: AtomicU64::new(1), outbox: Mutex::default(), pending: Mutex::default() })
    }

    pub fn take_outbox(&self) -> Vec<FetchRequest> {
        std::mem::take(&mut *self.outbox.lock().unwrap())
    }

    /// Answer fetch `id`; `None` (denied, failed, not an image) answers it empty.
    pub fn complete(&self, id: u64, bytes: Option<Vec<u8>>) -> bool {
        let Some((url, handler)) = self.pending.lock().unwrap().remove(&id) else { return false };
        handler.bytes(url, Bytes::from(bytes.unwrap_or_default()));
        true
    }

    /// Answer every outstanding request empty (doc closing, worker shutting down).
    pub fn fail_all(&self) {
        let drained: Vec<_> = self.pending.lock().unwrap().drain().collect();
        for (_, (url, handler)) in drained {
            handler.bytes(url, Bytes::new());
        }
        self.outbox.lock().unwrap().clear();
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
                    .unwrap_or_default();
                handler.bytes(url, Bytes::from(bytes));
            }
            "https" if self.allow_remote => {
                let id = self.next.fetch_add(1, Ordering::Relaxed);
                self.pending.lock().unwrap().insert(id, (url.clone(), handler));
                self.outbox.lock().unwrap().push(FetchRequest { id, url });
            }
            _ => handler.bytes(url, Bytes::new()),
        }
    }
}
