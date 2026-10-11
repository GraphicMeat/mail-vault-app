//! JMAP accounts (RFC 8620 core, RFC 8621 mail): the client the daemon's sync,
//! fetch, delete and send paths share.
//!
//! - `client`: `JmapClient`, one session over three tracked HTTP clients (API,
//!   transfer, push), every request recorded in Network Activity.
//! - `base`: which URLs may carry credentials (https, or loopback under the
//!   debug-only `MAILVAULT_JMAP_BASE` override).
//! - `mailbox_map`: JMAP mailboxes as the flat `MailboxInfo` list the app keeps.
//! - `headers`: `Email/get` properties as an `EmailHeader`, keywords as flags.
//! - `ops`: the label semantics rule every delete path goes through.
//! - `discover`: which session URL an address's domain offers, and whether
//!   its host needs the user's confirmation (the host trust rule).

pub mod base;
pub mod client;
pub mod discover;
pub mod headers;
pub mod mailbox_map;
pub mod ops;
pub mod types;

pub use client::{expand_template, JmapClient};
pub use ops::{remove_from, RemoveOutcome};
pub use types::*;
