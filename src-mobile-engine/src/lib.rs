//! The in-process engine behind the mobile shell. No Tauri dependency, and it never resolves a
//! data directory itself: the shell passes one to [`Engine::open`].

mod db;
mod rpc;
#[cfg(feature = "perf-gate")]
pub mod seed;

pub use db::{Engine, EngineError, SCHEMA_VERSION};
pub use rpc::{methods, RpcError};
