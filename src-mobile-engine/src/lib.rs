//! The in-process engine behind the mobile shell. No Tauri dependency, and it never resolves a
//! directory itself: the shell passes the data dir, the cache dir and the platform secret store to
//! [`Engine::open`]. IMAP and TLS come from mailvault-core, driven through [`net`].

mod account_settings;
mod accounts;
mod actions;
mod ai;
mod auto_tags;
mod attachments;
mod backend;
mod background;
mod billing_client;
mod bin;
mod body;
mod chat;
mod compose;
mod db;
mod fields;
mod followup;
mod hold;
mod live;
mod logs;
mod net_activity;
pub mod events;
pub mod net;
mod oauth;
mod offline;
pub mod outgoing;
mod outbox;
mod pgp;
mod premium;
mod remote_ids;
mod rpc;
mod search;
mod search_attach;
pub mod secrets;
mod settings;
mod storage;
mod sync;
mod tags;
mod threads;
mod tracking;
mod transfer;
mod usage;
mod views;
mod transfer_export;
mod unsubscribe;
#[cfg(feature = "perf-gate")]
pub mod seed;

pub use background::{BackgroundRun, NewMail};
pub use db::{Engine, EngineError, SCHEMA_VERSION};
pub use followup::FollowUpDue;
pub use outgoing::resolve_outgoing;
pub use premium::apple_account_token;
pub use rpc::{methods, RpcError};
#[doc(hidden)]
pub use search::BackfillStats;
pub use secrets::{Credential, MemorySecrets, SecretStore};
