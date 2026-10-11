//! Contacts: Person model over provider-less records, message-derived address
//! rows, counts, correspondence, merge and undo. Spec:
//! docs/superpowers/specs/2026-09-30-contacts-design.md
pub mod correspondence;
pub mod dedupe;
pub mod journal;
pub mod merge;
pub mod message_addr;
pub mod model;
pub mod review;
pub mod store;
pub mod suggest;
pub mod vcard;
