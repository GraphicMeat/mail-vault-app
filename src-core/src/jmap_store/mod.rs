//! The JMAP storage format (one `<uid>.json` record per message plus a
//! content-addressed blob store), the alternative to Maildir `cur/` files.
//!
//! - `record`: the `<uid>.json` record, an RFC 8621 Email metadata subset
//!   built from the raw bytes, and its flags as the Maildir letters A D F R S T.
//! - `blobs`: `<vault>/message_blobs/<h0h1>/<sha256hex>.eml`, the raw bytes,
//!   shared by every mailbox and account that holds the same message.

pub mod blobs;
pub mod record;
