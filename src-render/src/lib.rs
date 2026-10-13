//! MailVault's Blitz email renderer. Runs only inside the daemon's render
//! worker process (`mailvault-daemon --render-worker`), never in the daemon
//! itself: a panic here must cost one worker, not the daemon.
mod doc;
pub mod dommap;
pub mod fold;
pub mod fonts;
pub mod net;
pub mod serialize;
pub mod text;
pub mod worker;

pub use doc::{
    tile_dims, DocMeta, LinkInfo, OpenError, RenderDoc, RenderOptions, TileError, MAX_CSS_HEIGHT, MAX_CSS_WIDTH, MAX_DEPTH,
    MAX_HTML_BYTES, MAX_NODES, MAX_SCALE, MAX_TILE_PIXELS, MIN_SCALE, TILE_CSS_HEIGHT,
};
