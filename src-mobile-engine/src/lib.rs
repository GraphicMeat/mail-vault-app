//! The in-process engine behind the mobile shell. No Tauri dependency, and it never resolves a
//! directory itself: the shell passes the data dir, the cache dir and the platform secret store to
//! [`Engine::open`]. IMAP and TLS come from mailvault-core, driven through [`net`].

mod accounts;
mod actions;
mod attachments;
mod backend;
mod background;
mod body;
mod compose;
mod db;
mod hold;
mod live;
pub mod events;
pub mod net;
mod oauth;
pub mod outgoing;
mod outbox;
mod remote_ids;
mod rpc;
pub mod secrets;
mod settings;
mod sync;
#[cfg(feature = "perf-gate")]
pub mod seed;

pub use background::{BackgroundRun, NewMail};
pub use db::{Engine, EngineError, SCHEMA_VERSION};
pub use outgoing::resolve_outgoing;
pub use rpc::{methods, RpcError};
pub use secrets::{Credential, MemorySecrets, SecretStore};
