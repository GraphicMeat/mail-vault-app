//! One mailbox listing as the search index and the vault registry both read
//! it: the store's entries (`message_store::scan_dir`) as plain rows. A leaf
//! above `message_store` and below both consumers, so the registry lists a
//! mailbox without reaching into the index.

use crate::message_store;
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// One listed message (a `message_store::Entry`) as the index and the vault
/// registry store it.
pub(crate) struct DiskFile {
    pub(crate) uid: u32,
    /// `Entry.name`: with size and mtime, what change detection compares.
    pub(crate) filename: String,
    pub(crate) size: i64,
    pub(crate) mtime_ns: i64,
    /// `Entry.flags` as the letters the index stores (`messages.flags`).
    pub(crate) flags: String,
}

impl DiskFile {
    pub(crate) fn of(entry: message_store::Entry) -> Self {
        DiskFile {
            uid: entry.uid,
            size: i64::try_from(entry.size).unwrap_or(i64::MAX),
            mtime_ns: entry.mtime_ns as i64,
            flags: message_store::flag_letters(&entry.flags),
            filename: entry.name,
        }
    }
}

/// `list_files` with the listing's error kept, for the vault registry: there a
/// `NotFound` is a verified-empty folder, and only other errors are unknown.
/// The strict listing is `message_store::scan_dir`'s (a failure part way is
/// the whole listing's error, never a shorter folder).
pub(crate) fn read_mailbox(mailbox_dir: &Path) -> std::io::Result<(HashMap<u32, DiskFile>, HashSet<u32>)> {
    let scan = message_store::scan_dir(mailbox_dir)?;
    let files = scan.entries.into_iter().map(|entry| (entry.uid, DiskFile::of(entry))).collect();
    Ok((files, scan.unstatted.into_iter().collect()))
}
