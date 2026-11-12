//! JSON-RPC method handlers, one module per domain. `server::route_request`
//! routes to them (`rpc_registry::Domain`); the methods `server::route_inline`
//! answers itself call into `sync`, `snapshot`, `llm`, `classification` and
//! `people`. Nothing but module declarations lives here.

pub(crate) mod accounts;

pub(crate) mod abd;
pub(crate) mod ai;
pub(crate) mod alias_store;
pub(crate) mod aliases;
pub(crate) mod archive;
pub(crate) mod auto_tags;
pub(crate) mod backup;
pub(crate) mod backup_zip;
pub(crate) mod body;
pub(crate) mod cache;
pub(crate) mod classification;
pub(crate) mod cleanup;
pub(crate) mod common;
pub(crate) mod compose;
pub(crate) mod counts;
pub(crate) mod credentials;
pub(crate) mod custody;
pub(crate) mod custody_probe;
pub(crate) mod daemon;
pub(crate) mod deleted;
pub(crate) mod dns;
pub(crate) mod export_fetch;
pub(crate) mod fields;
pub(crate) mod folder_move;
pub(crate) mod fonts;
pub(crate) mod graph;
pub(crate) mod imap;
pub(crate) mod jmap_bridge;
pub(crate) mod learning;
pub(crate) mod llm;
pub(crate) mod insights;
pub(crate) mod insights_aggregate;
pub(crate) mod journal;
pub(crate) mod bulk;
pub(crate) mod mail_search;
pub(crate) mod mailboxes;
pub(crate) mod mbox;
pub(crate) mod message;
pub(crate) mod migration;
pub(crate) mod net_activity;
pub(crate) mod notes;
pub(crate) mod lifecycle;
pub(crate) mod notify;
pub(crate) mod oauth2;
pub(crate) mod pgp;
pub(crate) mod people;
pub(crate) mod people_scan;
pub(crate) mod policy;
pub(crate) mod people_write;
pub(crate) mod portable;
pub(crate) mod release_notes;
pub(crate) mod restore;
pub(crate) mod scheduled;
pub(crate) mod sync;
pub(crate) mod sync_observation;
pub(crate) mod refresh;
pub(crate) mod pipeline;
pub(crate) mod settings;
pub(crate) mod search_index;
pub(crate) mod snapshot;
pub(crate) mod snooze;
pub(crate) mod storage_format;
pub(crate) mod follow_up;
pub(crate) mod smtp;
pub(crate) mod tags;
pub(crate) mod transfer;
pub(crate) mod unsubscribe;
pub(crate) mod vault;
pub(crate) mod views;
pub(crate) mod vault_files;
pub(crate) mod vault_flags;

pub mod drafts;

pub(crate) mod compose_prep;

pub(crate) mod backup_schedule;
