//! The in-process engine behind the mobile shell. No Tauri dependency, and it never resolves a
//! directory itself: the shell passes the data dir, the cache dir and the platform secret store to
//! [`Engine::open`]. IMAP and TLS come from mailvault-core, driven through [`net`].

mod accounts;
mod actions;
mod attachments;
mod backend;
mod body;
mod db;
pub mod events;
pub mod net;
pub mod outgoing;
mod rpc;
pub mod secrets;
mod sync;
#[cfg(feature = "perf-gate")]
pub mod seed;

pub use db::{Engine, EngineError, SCHEMA_VERSION};
pub use outgoing::resolve_outgoing;
pub use rpc::{methods, RpcError};
pub use secrets::{Credential, MemorySecrets, SecretStore};
