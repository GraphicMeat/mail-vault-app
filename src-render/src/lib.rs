//! MailVault's Blitz email renderer. Runs only inside the daemon's render
//! worker process (`mailvault-daemon --render-worker`), never in the daemon
//! itself: a panic here must cost one worker, not the daemon.
mod doc;
pub mod net;
pub mod worker;

pub use doc::{DocMeta, LinkInfo, OpenError, RenderDoc, RenderOptions, MAX_CSS_HEIGHT, MAX_HTML_BYTES, MAX_NODES, TILE_CSS_HEIGHT};
