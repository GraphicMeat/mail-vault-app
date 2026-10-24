//! The one seam between the vault's message files and everything that reads
//! or writes them (Plan B, JMAP storage format). A caller asks here for a
//! uid's message, its flags or the mailbox's uid space, and never builds a
//! `cur/` path or parses a vault filename itself; `tests/message_store_guard.rs`
//! holds the rest of the tree to that.
//!
//! Disk only: nothing here touches the vault registry, so every function is
//! safe inside the daemon's `with_mailbox_write`. Registry bookkeeping stays
//! with the caller (`vault_files`, which uses the crate-private path-level
//! helpers `leaf_names`, `put`, `unlink_stale`, `rename_onto`, `unlink` and
//! `read_at` so its verified-mailbox fast paths keep their exact behaviour).
//!
//! Two formats, chosen per vault by the marker's `storageFormat` row
//! (`vault_format`):
//! - Maildir: `cur/<uid>:2,<FLAGS>.eml`, the flags in the name.
//! - JMAP: `jmap/<uid>.json`, a `jmap_store::record` holding the flags, whose
//!   bytes are a content-addressed blob in `<root>/message_blobs`.
//!
//! A mailbox may hold both at once (a conversion runs message by message).
//! Every reader reads both, and where one uid has both, the JMAP record wins.
//! Writers write the vault's format and never remove the other format's file;
//! only `write_replacing` and `remove_other_format` do, after the copy they
//! keep has verified. A record's name holds no flags, so a reader that keeps
//! only names (the vault registry, the search index) keeps the flag letters
//! beside them and reads flags off `flags_name`.
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tracing::warn;

use crate::jmap_store::{blobs, record};
use crate::maildir;
use crate::vault_eml::parse_flags_from_filename;
use crate::vault_files;

/// One stored message as the store sees it. `name` is the on-disk leaf
/// (`4182:2,AS.eml` or `4182.json`), kept for registry/search change detection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub uid: u32,
    pub flags: Vec<String>,
    pub size: u64,
    pub mtime_ns: i128,
    pub name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Maildir,
    Jmap,
}

/// The vault marker row (`vault_layout::read_marker_value`) holding the
/// storage format: `maildir` or `jmap`.
pub const FORMAT_KEY: &str = "storageFormat";

/// The vault marker row naming the job of a storage format conversion in
/// progress (the daemon's `format_migration_job`), the empty string when none is.
pub const MIGRATION_KEY: &str = "storageMigration";

/// The vault marker row hinting that the vault may still hold messages in
/// the format it is not in, with no stopped conversion to say so: `1`, or
/// the empty string. Set when a generation repair leaves Maildir files in a
/// JMAP vault (the daemon's `repair_generation_for`); emptied by every new
/// conversion job (not a Resume, which plans only the folders its run has
/// not finished), and by a same-direction start that finds nothing left.
/// Settings offers Convert remaining on it. A hint, never a count: a start
/// looks again (`holds_format`).
pub const LEFTOVER_KEY: &str = "storageLeftover";

/// Each vault root's format, read from its marker once per process.
fn formats() -> &'static RwLock<HashMap<PathBuf, Format>> {
    static FORMATS: OnceLock<RwLock<HashMap<PathBuf, Format>>> = OnceLock::new();
    FORMATS.get_or_init(Default::default)
}

/// The vault's storage format: the marker's `storageFormat` row, `Maildir`
/// when there is none (every vault made before the JMAP format). Read once per
/// root and cached; `set_vault_format` keeps the cache current and
/// `invalidate_vault_format` drops it. Only an answer is cached: a marker that
/// will not read gives `Maildir` for that call alone. Writers ask this;
/// readers never need to, since they read both formats.
pub fn vault_format(root: &Path) -> Format {
    if let Some(format) = formats().read().unwrap_or_else(|p| p.into_inner()).get(root) {
        return *format;
    }
    let format = match crate::vault_layout::read_marker_row(root, FORMAT_KEY) {
        Ok(Some(value)) if value == "jmap" => Format::Jmap,
        Ok(_) => Format::Maildir,
        // A read that failed is not an answer: remembering `Maildir` here would
        // turn a JMAP vault mixed for the life of the process on one busy or
        // unreachable moment. This call writes Maildir; the next one asks again.
        Err(e) => {
            warn!("message_store: the storage format of {} is unknown, using Maildir for now: {e}", root.display());
            return Format::Maildir;
        }
    };
    // `entry`: a `set_vault_format` that landed since the cache miss wins.
    *formats().write().unwrap_or_else(|p| p.into_inner()).entry(root.to_path_buf()).or_insert(format)
}

/// Forgets the cached format of the vault at `root`, so the next
/// `vault_format` reads its marker again. For a vault adopted or moved to a
/// root that this process has already asked about (the marker there is a
/// different file now). `set_vault_format` needs no call: it writes the cache.
pub fn invalidate_vault_format(root: &Path) {
    formats().write().unwrap_or_else(|p| p.into_inner()).remove(root);
}

/// Writes `format` to the vault marker, then to the cache `vault_format`
/// reads. From here on every writer writes `format`; nothing on disk is
/// converted (the conversion job does that, message by message).
pub fn set_vault_format(root: &Path, format: Format) -> Result<(), String> {
    let value = match format {
        Format::Maildir => "maildir",
        Format::Jmap => "jmap",
    };
    crate::vault_layout::write_marker_value(root, FORMAT_KEY, value)?;
    formats().write().unwrap_or_else(|p| p.into_inner()).insert(root.to_path_buf(), format);
    Ok(())
}

/// Whether the vault's marker hints that messages are left in the format it
/// is not in (`LEFTOVER_KEY`). One marker read; a marker that will not read
/// says no.
pub fn leftover(root: &Path) -> bool {
    crate::vault_layout::read_marker_value(root, LEFTOVER_KEY).as_deref() == Some("1")
}

/// Sets (`1`) or empties the vault's `LEFTOVER_KEY` row.
pub fn set_leftover(root: &Path, on: bool) -> Result<(), String> {
    crate::vault_layout::write_marker_value(root, LEFTOVER_KEY, if on { "1" } else { "" })
}

/// Whether the vault has a blob store (`message_blobs/`): one stat, no walk.
/// Settings offers Reclaim in either format while it is there.
pub fn has_blob_store(root: &Path) -> bool {
    root.join(blobs::BLOB_DIR).is_dir()
}

/// The mailbox directory (holds cur/, jmap/, .uidvalidity, orphaned/, .decrypted/ ...). Dir-level callers
/// (rename, adopt, pgp copies, rehome ledger) use this, never `cur/` directly.
pub fn mailbox_dir(root: &Path, account_id: &str, mailbox: &str) -> PathBuf {
    vault_files::account_dir(&root.join("Maildir"), account_id).join(crate::search_index::text::vault_dir_name(mailbox))
}

/// The mailbox's Maildir message directory. Private: callers ask by uid.
fn messages_dir(root: &Path, account_id: &str, mailbox: &str) -> PathBuf {
    messages_in(&mailbox_dir(root, account_id, mailbox))
}

/// The Maildir message directory inside the mailbox directory `mailbox_dir`.
/// The one place the store names it.
fn messages_in(mailbox_dir: &Path) -> PathBuf {
    mailbox_dir.join("cur")
}

fn mtime_ns(meta: &fs::Metadata) -> i128 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as i128)
}

// ── The JMAP format's records ────────────────────────────────────────────────

/// The directory of a mailbox's JMAP records, beside its Maildir `cur/`.
pub(crate) const JMAP_DIR: &str = "jmap";

/// The JMAP record directory inside the mailbox directory `mailbox_dir`.
fn jmap_in(mailbox_dir: &Path) -> PathBuf {
    mailbox_dir.join(JMAP_DIR)
}

/// `<uid>.json`: the leaf of `uid`'s record, and its `Entry.name`.
fn record_name(uid: u32) -> String {
    format!("{uid}.json")
}

/// The uid a record leaf names: canonical decimal digits (no sign, no
/// leading zero) then `.json`. A temp name (`.7.json.tmp-...`) or anything
/// else in `jmap/` is not a record.
pub(crate) fn record_uid(name: &str) -> Option<u32> {
    let digits = name.strip_suffix(".json")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) || (digits.len() > 1 && digits.starts_with('0')) {
        return None;
    }
    digits.parse().ok()
}

/// A rule reading the uid a file name carries.
type UidOf = fn(&str) -> Option<u32>;

/// Whether `path` is a record: a record leaf in a `jmap/` directory.
pub(crate) fn is_record_path(path: &Path) -> bool {
    path.parent().and_then(Path::file_name).is_some_and(|dir| dir == JMAP_DIR)
        && path.file_name().is_some_and(|name| record_uid(&name.to_string_lossy()).is_some())
}

/// The vault root a mailbox directory (`<root>/Maildir/<account dir>/<vault
/// dir>`, as `mailbox_dir` and `mailbox_dir_at` build it) sits in: where its
/// records' blobs are.
fn root_of(mailbox_dir: &Path) -> &Path {
    mailbox_dir.ancestors().nth(3).unwrap_or(mailbox_dir)
}

/// The record at `path`. A record that will not parse is `InvalidData`.
fn read_record(path: &Path) -> io::Result<record::Record> {
    let bytes = fs::read(path)?;
    record::parse(&bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// The entry of the record at `path` (of `uid`): `record.size`, the record
/// file's mtime and the record's flags. Stated before it is read, so a rewrite
/// in between leaves an mtime older than the content, never newer: the next
/// listing then sees the change.
fn record_entry(uid: u32, path: &Path) -> io::Result<Entry> {
    let meta = fs::metadata(path)?;
    let rec = read_record(path)?;
    Ok(Entry { uid, flags: record::flags_of(&rec), size: rec.size, mtime_ns: mtime_ns(&meta), name: record_name(uid) })
}

/// The entry of a record just written or rewritten at `path`.
fn written_entry(uid: u32, rec: &record::Record, path: &Path) -> Entry {
    let mtime_ns = fs::metadata(path).map_or(0, |m| mtime_ns(&m));
    Entry { uid, flags: record::flags_of(rec), size: rec.size, mtime_ns, name: record_name(uid) }
}

/// `uid`'s record in the mailbox directory and its path. `Ok(None)` when it
/// has none, or one that will not parse (logged): the Maildir file of the uid,
/// if any, is read instead. Any other read error is returned.
fn record_of(mailbox_dir: &Path, uid: u32) -> io::Result<Option<(PathBuf, record::Record)>> {
    let path = jmap_in(mailbox_dir).join(record_name(uid));
    match read_record(&path) {
        Ok(rec) => Ok(Some((path, rec))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) if e.kind() == io::ErrorKind::InvalidData => {
            warn!("message_store: record {} will not parse: {e}", path.display());
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

/// The record entries of the mailbox directory, one per record that reads, in
/// `read_dir` order: `list`'s rules (a missing directory is empty, an entry
/// that will not read is skipped). A record that will not stat or parse is
/// left out (logged), so the Maildir file of its uid, if any, is listed.
fn list_records(mailbox_dir: &Path) -> io::Result<Vec<Entry>> {
    let entries = match fs::read_dir(jmap_in(mailbox_dir)) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let Some(uid) = record_uid(&entry.file_name().to_string_lossy()) else { continue };
        match record_entry(uid, &entry.path()) {
            Ok(listed) => out.push(listed),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => warn!("message_store: record {} will not read: {e}", entry.path().display()),
        }
    }
    Ok(out)
}

/// Every record leaf of the mailbox directory by uid, from one names-only
/// listing (no parse): lenient, a directory that is missing or will not list
/// holds none and an entry that will not read is skipped.
fn record_paths_at(mailbox_dir: &Path) -> HashMap<u32, PathBuf> {
    fs::read_dir(jmap_in(mailbox_dir))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| Some((record_uid(&entry.file_name().to_string_lossy())?, entry.path())))
        .collect()
}

/// Whether `path` is a blob of the blob store: `message_blobs/<h0h1>/<hex>.eml`.
fn is_blob_path(path: &Path) -> bool {
    path.parent().and_then(Path::parent).and_then(Path::file_name).is_some_and(|dir| dir == blobs::BLOB_DIR)
}

/// The vault root of a record path (`<root>/Maildir/<account>/<dir>/jmap/<uid>.json`).
fn root_of_record(path: &Path) -> Option<&Path> {
    Some(root_of(path.parent()?.parent()?))
}

/// The bytes of a listed path, whatever a store listing handed out: a
/// record's blob, else the file itself. A record or blob gone is `NotFound`.
pub fn read_path(path: &Path) -> io::Result<Vec<u8>> {
    if !is_record_path(path) {
        return fs::read(path);
    }
    let rec = read_record(path)?;
    let root = root_of_record(path).ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
    blobs::get(root, &rec.blob)
}

/// The flags of the record at `path`, `None` when it will not read.
pub(crate) fn record_flags_at(path: &Path) -> Option<Vec<String>> {
    read_record(path).ok().map(|rec| record::flags_of(&rec))
}

/// For a listed record path, what a reader of the message needs: its uid, the
/// file holding its bytes (the blob) and the name its flags read off
/// (`flags_name`). `None` for any other path, or a record that will not read.
pub fn listed_message(path: &Path) -> Option<(u32, PathBuf, String)> {
    if !is_record_path(path) {
        return None;
    }
    let rec = read_record(path).ok()?;
    let uid = record_uid(&path.file_name()?.to_string_lossy())?;
    Some((uid, blobs::blob_path(root_of_record(path)?, &rec.blob), entry_name(uid, &record::flags_of(&rec))))
}

/// `uid`'s bytes as a file opened for reading: its record's blob, else its
/// Maildir file. `Ok(None)`: the mailbox holds neither.
fn open_held(root: &Path, mailbox_dir: &Path, uid: u32) -> io::Result<Option<fs::File>> {
    if let Some((_, rec)) = record_of(mailbox_dir, uid)? {
        return fs::File::open(blobs::blob_path(root, &rec.blob)).map(Some);
    }
    open_by_uid(&messages_in(mailbox_dir), uid)
}

/// The record of `uid` built from `raw` under `flags`, its blob stored, and
/// the record written atomically to `jmap/<uid>.json` in the mailbox directory.
/// An existing record's server ids and `receivedAt` are kept (the same uid is
/// the same message); with neither, `receivedAt` is the Date header, else the
/// uid's Maildir file's mtime, else now. Removes nothing.
///
/// The blob goes in before the record (`blobs::put`), and a `put` that fails
/// fails the write with no record written. That includes an existing blob
/// whose mtime `put` cannot refresh (a read-only file): so no record ever
/// names a blob its own write did not make young, and `sweep_blobs`' grace
/// period always covers the window between a `put` and its record.
///
/// `raw` is hashed once, by the record build; the blob is stored under that
/// id (`blobs::put_as`). Returns the entry and the blob id, for a caller that
/// verifies the write against it.
///
/// The build and the blob are `prepare`'s half, the record file `commit`'s:
/// one code path for every writer of a record.
pub(crate) fn write_record(root: &Path, mailbox_dir: &Path, uid: u32, raw: &[u8], flags: &[String]) -> Result<(Entry, String), String> {
    let rec = build_record(mailbox_dir, uid, raw, flags, None)?;
    blobs::put_as(root, raw, rec.blob.clone())?;
    let entry = commit_record(root, mailbox_dir, uid, &rec, flags)?;
    Ok((entry, rec.blob))
}

/// The record of `uid` built from `raw` under `flags`, for the mailbox
/// directory `mailbox_dir`; nothing written. `receivedAt` is `received_at`
/// when given (the header cache's INTERNALDATE), else the Date header, else
/// the uid's Maildir file's mtime, else now. One sha256 of `raw`.
fn build_record(mailbox_dir: &Path, uid: u32, raw: &[u8], flags: &[String], received_at: Option<&str>) -> Result<record::Record, String> {
    let vault_dir = mailbox_dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut rec = match record::build(uid, &vault_dir, raw, flags, received_at, None) {
        Ok(rec) => rec,
        // Bytes the parser refuses (a first line that starts with a space, a
        // lone CR where a header line starts) are still a message the vault
        // keeps, as Maildir keeps any bytes: the record is built from them read
        // as a body with no headers, then made to name these very bytes.
        Err(_) => {
            let mut padded = b"\r\n".to_vec();
            padded.extend_from_slice(raw);
            let mut rec = record::build(uid, &vault_dir, &padded, flags, received_at, None)?;
            let id = blobs::blob_id(raw);
            rec.blob = id.clone();
            rec.size = raw.len() as u64;
            if let Some(email) = rec.email.as_object_mut() {
                if rec.server.is_none() {
                    email.insert("id".into(), Value::String(format!("L{uid}-{}", &id["sha256-".len().."sha256-".len() + 12])));
                }
                email.insert("blobId".into(), Value::String(id));
                email.insert("size".into(), Value::from(raw.len() as u64));
            }
            rec
        }
    };
    if rec.email.get("receivedAt").and_then(Value::as_str).is_none() {
        let when = path_of(&messages_in(mailbox_dir), uid)
            .and_then(|file| fs::metadata(file).ok())
            .and_then(|meta| meta.modified().ok())
            .unwrap_or_else(SystemTime::now);
        let stamp = chrono::DateTime::<chrono::Utc>::from(when).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        if let Some(email) = rec.email.as_object_mut() {
            email.insert("receivedAt".into(), Value::String(stamp));
        }
    }
    Ok(rec)
}

/// Writes the record `built` (from `build_record`, its blob already stored)
/// as `uid`'s `jmap/<uid>.json` in the mailbox directory, atomically, under
/// `flags`. An existing record's `receivedAt` is kept (the same uid is the
/// same message), and so are its server ids unless `built` carries ids of
/// its own (`Prepared::with_server_ids`: the server's answer now). The blob
/// is made young again first
/// (`blobs::touch`), so a sweep's grace period covers the record however long
/// ago the blob was stored. Removes nothing; no hash.
fn commit_record(root: &Path, mailbox_dir: &Path, uid: u32, built: &record::Record, flags: &[String]) -> Result<Entry, String> {
    let records = jmap_in(mailbox_dir);
    let path = records.join(record_name(uid));
    let mut rec = record::with_flags(built, flags);
    if let Ok(old) = read_record(&path) {
        keep_identity(&mut rec, &old);
    }
    blobs::touch(root, &rec.blob)?;
    fs::create_dir_all(&records).map_err(|e| io_failure("Failed to create the message record directory", &e))?;
    let json = serde_json::to_vec(&rec).map_err(|e| format!("Failed to encode the message record: {e}"))?;
    crate::fsx::write_atomic(&path, &json).map_err(|e| io_failure("Failed to write the message record", &e))?;
    Ok(written_entry(uid, &rec, &path))
}

/// What a new record of a uid keeps from the record it replaces:
/// `receivedAt`, and the server's ids (`put_server_ids`) when the new record
/// has none of its own. Ids it was prepared with are the server's answer now
/// and win.
fn keep_identity(rec: &mut record::Record, old: &record::Record) {
    if let (Some(email), Some(received)) = (rec.email.as_object_mut(), old.email.get("receivedAt").and_then(Value::as_str)) {
        email.insert("receivedAt".into(), Value::String(received.to_owned()));
    }
    let kept = if rec.server.is_none() { old.server.clone() } else { None };
    if let Some(ids) = kept {
        put_server_ids(rec, ids);
    }
}

/// `ids` as `rec`'s server ids: `server`, and the `email.id` and
/// `email.threadId` they give. A `threadId` the server did not send leaves
/// the local one.
fn put_server_ids(rec: &mut record::Record, ids: record::ServerIds) {
    if let Some(email) = rec.email.as_object_mut() {
        email.insert("id".into(), Value::String(ids.email_id.clone()));
        if let Some(thread) = &ids.thread_id {
            email.insert("threadId".into(), Value::String(thread.clone()));
        }
    }
    rec.server = Some(ids);
}

/// Rewrites the record at `path` (of `uid`) under `flags` (`record::with_flags`,
/// which keeps every other keyword): no rename, and nothing written when the
/// flags already match. Returns the entry after the change and whether it
/// changed.
pub(crate) fn set_record_flags(path: &Path, uid: u32, flags: &[String]) -> Result<(Entry, bool), String> {
    let rec = read_record(path).map_err(|e| format!("Failed to read the message record: {e}"))?;
    let new = record::with_flags(&rec, flags);
    let changed = new != rec;
    if changed {
        let json = serde_json::to_vec(&new).map_err(|e| format!("Failed to encode the message record: {e}"))?;
        crate::fsx::write_atomic(path, &json).map_err(|e| format!("Failed to rewrite the message record: {e}"))?;
    }
    Ok((written_entry(uid, &new, path), changed))
}

/// The entry for the leaf `name` of `uid`. `meta` is its stat; a failed stat
/// counts as size and mtime 0, as `vault_files::list_on_disk` always did.
fn entry_of(uid: u32, name: String, meta: Option<fs::Metadata>) -> Entry {
    let (size, mtime_ns) = meta.map_or((0, 0), |m| (m.len(), mtime_ns(&m)));
    Entry { uid, flags: parse_flags_from_filename(&name), size, mtime_ns, name }
}

/// The file holding `uid` in the message directory `dir`, by `find_by_uid`'s
/// prefix rule.
fn path_of(dir: &Path, uid: u32) -> Option<PathBuf> {
    maildir::find_by_uid(dir, uid)
}

/// `uid`'s file opened for reading. A flag change renames the file between
/// the scan and the open, so a vanished name gets one rescan.
fn open_by_uid(dir: &Path, uid: u32) -> io::Result<Option<fs::File>> {
    for _ in 0..2 {
        let Some(path) = path_of(dir, uid) else { return Ok(None) };
        match fs::File::open(&path) {
            Ok(file) => return Ok(Some(file)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(None)
}

/// Disk only; never touches the registry (safe inside with_mailbox_write). NotFound dir = Ok(empty).
/// One entry per vault file (`maildir::vault_filename_uid`'s rule), by uid then
/// name. An entry that will not stat counts as size and mtime 0.
pub fn list(root: &Path, account_id: &str, mailbox: &str) -> io::Result<Vec<Entry>> {
    list_at(&mailbox_dir(root, account_id, mailbox))
}

/// `list` of the mailbox directory `mailbox_dir`, for a caller that walks the
/// mailbox directories by their on-disk names (a snapshot).
///
/// Both formats: every JMAP record that reads (`<uid>.json`), and every
/// Maildir file of a uid no record holds. A missing directory of either format
/// is empty; either one failing to list is the error.
pub fn list_at(mailbox_dir: &Path) -> io::Result<Vec<Entry>> {
    let mut out = Vec::new();
    match fs::read_dir(messages_in(mailbox_dir)) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let Some(uid) = maildir::vault_filename_uid(&name) else { continue };
                out.push(entry_of(uid, name, entry.metadata().ok()));
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let records = list_records(mailbox_dir)?;
    if !records.is_empty() {
        let held: HashSet<u32> = records.iter().map(|e| e.uid).collect();
        out.retain(|e| !held.contains(&e.uid));
        out.extend(records);
    }
    out.sort_by(|a, b| (a.uid, &a.name).cmp(&(b.uid, &b.name)));
    Ok(out)
}

/// What the messages of some mailbox directories take on disk (`disk_usage`).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct DiskUsage {
    /// One per message as `list_at` lists them: a record that reads, else a
    /// Maildir file.
    pub messages: u32,
    /// Every Maildir file and every record file, and each blob the records
    /// name once, however many records share it.
    pub bytes: u64,
}

/// The storage counters (`vault_files::storage_stats`) over the mailbox
/// directories `mailbox_dirs`. A Maildir file beside a record of its uid
/// (a conversion in progress) is not a message of its own, but its bytes are
/// on the disk and count. Lenient, as a counter that nothing acts on: a
/// directory that is missing or will not list counts as empty, a file that
/// will not stat counts no bytes, and a blob that is not there counts none.
/// Each record is read once.
pub fn disk_usage(mailbox_dirs: &[PathBuf]) -> DiskUsage {
    let mut usage = DiskUsage::default();
    let mut blobs_seen: HashSet<String> = HashSet::new();
    for mailbox_dir in mailbox_dirs {
        let root = root_of(mailbox_dir);
        let mut held = HashSet::new();
        for entry in fs::read_dir(jmap_in(mailbox_dir)).into_iter().flatten().flatten() {
            let Some(uid) = record_uid(&entry.file_name().to_string_lossy()) else { continue };
            // `list_records`' rule: a record that will not stat or read is
            // left out, and the Maildir file of its uid is the message.
            let Ok(meta) = entry.metadata() else { continue };
            usage.bytes += meta.len();
            let Ok(rec) = read_record(&entry.path()) else { continue };
            held.insert(uid);
            usage.messages += 1;
            if blobs_seen.insert(rec.blob.clone()) {
                usage.bytes += fs::metadata(blobs::blob_path(root, &rec.blob)).map_or(0, |m| m.len());
            }
        }
        for entry in fs::read_dir(messages_in(mailbox_dir)).into_iter().flatten().flatten() {
            let Some(uid) = maildir::vault_filename_uid(&entry.file_name().to_string_lossy()) else { continue };
            usage.bytes += entry.metadata().map_or(0, |m| m.len());
            if !held.contains(&uid) {
                usage.messages += 1;
            }
        }
    }
    usage
}

/// How many messages the tree under `dir` holds, by name alone (no stat, no
/// parse), for a folder the user picked (`vault_ops::count_messages`), whose
/// layout is not known: every file with a Maildir info part at any depth,
/// and every record leaf of a `jmap/` directory. A file in a mailbox's
/// Maildir message directory whose uid has a record beside it is that
/// record's message, counted once. A directory that will not list counts as
/// empty.
pub fn count_under(dir: &Path) -> usize {
    count_in(dir, &HashSet::new())
}

/// `count_under` of `dir`, leaving out each Maildir file of a uid in `shadowed`.
fn count_in(dir: &Path, shadowed: &HashSet<u32>) -> usize {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    let mut count = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            count += if path == jmap_in(dir) {
                record_paths_at(dir).len()
            } else if path == messages_in(dir) {
                count_in(&path, &record_paths_at(dir).into_keys().collect())
            } else {
                count_in(&path, &HashSet::new())
            };
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if maildir::has_info(&name) && !maildir::vault_filename_uid(&name).is_some_and(|uid| shadowed.contains(&uid)) {
            count += 1;
        }
    }
    count
}

/// Disk only. The entry for `uid`, or `None` when the mailbox holds no file for it.
/// Its record when it has one that reads, else its Maildir file.
pub fn find(root: &Path, account_id: &str, mailbox: &str, uid: u32) -> Option<Entry> {
    find_at(&mailbox_dir(root, account_id, mailbox), uid)
}

/// Which directory of a mailbox a taken file is in, in listing order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Taken {
    /// The Maildir message directory.
    Message,
    /// The JMAP record directory.
    Record,
    /// `orphaned/`: set aside, never held.
    Orphaned,
}

/// Every file of the mailbox directory `mailbox_dir` that names a uid:
/// `(where, uid, path)`, its message directory first, then its JMAP records,
/// then `orphaned/`, each in `read_dir` order. A Maildir or `orphaned/` uid is
/// read by the loosest rule any reader uses (`maildir::mirror_filename_uid`:
/// legacy `12.eml`, `.regen` leftovers, `orphaned/`'s `.1` dedupe suffixes),
/// exactly as `graph_ledger`'s allocator has always counted a uid as taken; a
/// record's by its `<uid>.json` name, read or not. A missing directory is
/// empty; any other listing failure, including one unreadable entry, is an
/// error that names the directory (`could not list <dir>: <cause>`, its kind
/// kept): reading it as empty would hand out a uid a file on disk already
/// carries.
fn taken_files_at(mailbox_dir: &Path) -> io::Result<Vec<(Taken, u32, PathBuf)>> {
    let dirs = [
        (Taken::Message, messages_in(mailbox_dir)),
        (Taken::Record, jmap_in(mailbox_dir)),
        (Taken::Orphaned, mailbox_dir.join(maildir::ORPHAN_DIR)),
    ];
    let mut out = Vec::new();
    for (taken, dir) in dirs {
        let unlisted = |e: io::Error| io::Error::new(e.kind(), format!("could not list {}: {}", dir.display(), e));
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(unlisted(e)),
        };
        for entry in entries {
            let entry = entry.map_err(unlisted)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let uid = match taken {
                Taken::Record => record_uid(&name),
                Taken::Message | Taken::Orphaned => maildir::mirror_filename_uid(&name),
            };
            if let Some(uid) = uid {
                out.push((taken, uid, entry.path()));
            }
        }
    }
    Ok(out)
}

/// `taken_files_at` of the mailbox, each directory by uid then path.
fn taken_files(root: &Path, account_id: &str, mailbox: &str) -> io::Result<Vec<(Taken, u32, PathBuf)>> {
    let mut out = taken_files_at(&mailbox_dir(root, account_id, mailbox))?;
    out.sort();
    Ok(out)
}

/// Every uid this mailbox holds or held: cur/ + jmap/ + orphaned/. The ONLY source for "which uids are taken".
/// By the loose rule `taken_files` documents. Includes the mbox import range
/// (`is_import_uid`); a caller that allocates server-range uids leaves those
/// out.
pub fn uids(root: &Path, account_id: &str, mailbox: &str) -> io::Result<BTreeSet<u32>> {
    Ok(taken_files(root, account_id, mailbox)?.into_iter().map(|(_, uid, _)| uid).collect())
}

/// The highest uid `uids` holds, 0 when empty. Not filtered by range: after
/// an mbox import this is an import-range uid.
pub fn highest_uid(root: &Path, account_id: &str, mailbox: &str) -> io::Result<u32> {
    Ok(uids(root, account_id, mailbox)?.last().copied().unwrap_or(0))
}

/// The uids of the messages `mailbox` holds, ascending: one names-only
/// listing of each message directory (Maildir, then JMAP records) that takes
/// no lock. (The vault registry's listing stats every file and holds its
/// locks for the whole folder, and opening a message waits on those.) A
/// regular file named `<uid>:2,...` or `<uid>.json` is a copy; a symlink, a
/// directory, a dot-prefixed temp name (`maildir::vault_filename_uid` and the
/// record rule refuse it) or any other name is not, and `orphaned/` is never
/// read: a set-aside copy is not held. No message directory under a vault
/// `root` that is there is an empty folder; a root that is gone, or a listing
/// that fails at any point, is `None`: unknown, never empty. The vault gap
/// walks this (`vault_gap::Gap`).
pub fn held_uids(root: &Path, account_id: &str, mailbox: &str) -> Option<Vec<u32>> {
    let mailbox = mailbox_dir(root, account_id, mailbox);
    let mut uids = Vec::new();
    let dirs: [(PathBuf, UidOf); 2] = [(messages_in(&mailbox), maildir::vault_filename_uid), (jmap_in(&mailbox), record_uid)];
    for (dir, uid_of) in dirs {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound && root.is_dir() => continue,
            Err(_) => return None,
        };
        for entry in entries {
            // An error part way ends the listing: a shorter folder it is not.
            let entry = entry.ok()?;
            // The type comes with the listing on most file systems. Where it
            // needs a stat and that fails (a flag rename in between), the name
            // still says a copy was there.
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(true) {
                continue;
            }
            if let Some(uid) = uid_of(&entry.file_name().to_string_lossy()) {
                uids.push(uid);
            }
        }
    }
    uids.sort_unstable();
    uids.dedup();
    Some(uids)
}

/// Whether `uid` is in the mbox import range (`maildir::IMPORT_UID_BASE` and
/// up): a number the vault gave an imported message, never a server's.
pub fn is_import_uid(uid: u32) -> bool {
    uid >= maildir::IMPORT_UID_BASE
}

/// The next uid of the mbox import range above every import-range uid in
/// `taken`: the range's first uid when `taken` holds none of them, `None`
/// once the range is full. For an allocator of import-range uids.
pub fn next_import_uid(taken: impl IntoIterator<Item = u32>) -> Option<u32> {
    taken.into_iter().filter(|uid| is_import_uid(*uid)).max().map_or(Some(maildir::IMPORT_UID_BASE), |m| m.checked_add(1))
}

/// (uid, normalized Message-ID) for cur/ + jmap/ (+ orphaned/): graph_ledger adoption, mbox dedupe.
/// One pair per file `uids` counts, message directory first, then the JMAP
/// records, then `orphaned/`, each by uid; a uid can appear more than once (a
/// Maildir copy, a record, a set-aside one). A record's id is read from its
/// blob (`message_id_at`). `None` when the header carries no Message-ID or
/// the file will not read. An `orphaned/` pair only says the uid is taken: a
/// caller adopting a uid for a server message checks it is held (`find`).
pub fn uid_message_ids(root: &Path, account_id: &str, mailbox: &str) -> io::Result<Vec<(u32, Option<String>)>> {
    Ok(taken_files(root, account_id, mailbox)?.into_iter().map(|(_, uid, path)| (uid, message_id_at(&path))).collect())
}

/// The normalized Message-ID of the listed file `path` (`maildir::read_message_id`):
/// a record's is read from its blob, any other file's from the file.
pub fn message_id_at(path: &Path) -> Option<String> {
    if !is_record_path(path) {
        return maildir::read_message_id(path);
    }
    let rec = read_record(path).ok()?;
    let mailbox_dir = path.parent()?.parent()?;
    maildir::read_message_id(&blobs::blob_path(root_of(mailbox_dir), &rec.blob))
}

/// `uid`'s raw RFC 5322 bytes, `None` when the mailbox holds no file for it.
/// A record's blob; else the Maildir file.
pub fn read_raw(root: &Path, account_id: &str, mailbox: &str, uid: u32) -> io::Result<Option<Vec<u8>>> {
    let Some(mut file) = open_held(root, &mailbox_dir(root, account_id, mailbox), uid)? else { return Ok(None) };
    let mut raw = Vec::new();
    file.read_to_end(&mut raw)?;
    Ok(Some(raw))
}

/// The header section of `uid`'s first `max` bytes: everything before the
/// first blank line, or all `max` bytes when there is none in them.
pub fn read_header_section(root: &Path, account_id: &str, mailbox: &str, uid: u32, max: usize) -> io::Result<Option<Vec<u8>>> {
    let Some(file) = open_held(root, &mailbox_dir(root, account_id, mailbox), uid)? else { return Ok(None) };
    let mut buf = Vec::new();
    file.take(max as u64).read_to_end(&mut buf)?;
    Ok(Some(maildir::header_section(&buf).to_vec()))
}

/// Writes in the vault's format. Never removes the other format's file for this uid.
/// Maildir: the new name goes in atomically, then every other file of this
/// uid in the same format (an older flags name, a crash-left duplicate) is
/// removed; one that will not go is logged and left. JMAP: the blob, then
/// `jmap/<uid>.json` atomically (`write_record`); a record has one name, so
/// there is nothing stale to remove.
pub fn write(root: &Path, account_id: &str, mailbox: &str, uid: u32, raw: &[u8], flags: &[String]) -> Result<Entry, String> {
    if vault_format(root) == Format::Jmap {
        return write_record(root, &mailbox_dir(root, account_id, mailbox), uid, raw, flags).map(|(entry, _)| entry);
    }
    let dir = messages_dir(root, account_id, mailbox);
    let stale = leaf_names(&dir, uid);
    let entry = put(&dir, uid, raw, flags)?;
    if unlink_stale(&dir, &entry.name, &stale) {
        warn!("message_store: an older copy of uid {uid} could not be removed");
    }
    Ok(entry)
}

/// write() + verify the new copy by re-reading it + remove the other format's file. For ordinary writers.
/// The verify and the removal run only when the mailbox holds `uid` in the
/// other format too. A copy that fails to verify is removed again, so the
/// other format's copy stays the one every reader reads, and the error is
/// returned. A verified write whose old copy will not go is logged and kept:
/// the new copy is the one every reader reads (a record wins over a Maildir
/// file; a Maildir file left beside a removed record is alone).
///
/// `prepare` then `commit_replacing`, in the vault's format, in one go.
pub fn write_replacing(root: &Path, account_id: &str, mailbox: &str, uid: u32, raw: &[u8], flags: &[String]) -> Result<Entry, String> {
    let prepared = prepare(root, account_id, mailbox, uid, raw.to_vec(), flags, None, vault_format(root))?;
    commit_replacing(root, account_id, mailbox, &prepared, flags)
}

// ── Prepare, then commit ─────────────────────────────────────────────────────
//
// A write in two halves, so the heavy one runs before the mailbox lock: the
// parse, the hash and the blob write (`prepare`, outside any lock), then the
// record or file (`commit`, under the daemon's `with_mailbox_write`, one
// message at a time). The conversion job (Task 9) and the fetch's cache
// writes (`vault_files::store_prepared`) go this way. A record's blob is
// young from `prepare` on, and `commit` makes it young again before the
// record names it, so a sweep in between never takes it.

/// A message made ready to be one uid's copy in one format (`prepare`): the
/// bytes, and in JMAP format the record built from them, whose blob is
/// already stored.
#[derive(Clone, Debug)]
pub struct Prepared {
    root: PathBuf,
    uid: u32,
    raw: Vec<u8>,
    record: Option<record::Record>,
    /// The server's ids (`with_server_ids`), in either format: `record`
    /// carries them too in JMAP format.
    server: Option<record::ServerIds>,
}

impl Prepared {
    pub fn uid(&self) -> u32 {
        self.uid
    }

    /// The vault root it was prepared in: its blob is there.
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn raw(&self) -> &[u8] {
        &self.raw
    }

    /// The format `commit` writes it in.
    pub fn format(&self) -> Format {
        if self.record.is_some() { Format::Jmap } else { Format::Maildir }
    }

    /// The same message with the server's ids (a JMAP account's `emailId`,
    /// `blobId`, `threadId`; Plan A Task 14): in JMAP format the record
    /// `commit` writes carries them (`put_server_ids`), in that one write.
    pub fn with_server_ids(mut self, ids: record::ServerIds) -> Prepared {
        if let Some(rec) = self.record.as_mut() {
            put_server_ids(rec, ids.clone());
        }
        self.server = Some(ids);
        self
    }

    /// The ids `with_server_ids` gave it, for a caller that stores the
    /// message without committing it (`vault_files::store_prepared` on a uid
    /// already held, or one it stores the plain way).
    pub fn server_ids(&self) -> Option<&record::ServerIds> {
        self.server.as_ref()
    }
}

/// Makes `raw` ready to be `uid`'s copy in `format`, outside any lock. JMAP:
/// the record is built under `flags` and the blob stored (`blobs::put_as`,
/// which also makes an existing blob young); `received_at`, when given, is
/// the record's `receivedAt` (the header cache's INTERNALDATE), else the Date
/// header, else the uid's Maildir file's mtime, else now. The message's one
/// hash is made here. Maildir: nothing to do ahead. No record or message file
/// is written.
#[allow(clippy::too_many_arguments)]
pub fn prepare(
    root: &Path,
    account_id: &str,
    mailbox: &str,
    uid: u32,
    raw: Vec<u8>,
    flags: &[String],
    received_at: Option<&str>,
    format: Format,
) -> Result<Prepared, String> {
    prepare_at(root, &mailbox_dir(root, account_id, mailbox), uid, raw, flags, received_at, format)
}

/// `prepare` for the mailbox directory `mailbox_dir`, named as it is on disk
/// (`mailbox_dir_at`), for a folder whose name does not survive
/// `vault_dir_name`. The conversion job addresses every folder this way.
#[allow(clippy::too_many_arguments)]
pub fn prepare_at(root: &Path, mailbox_dir: &Path, uid: u32, raw: Vec<u8>, flags: &[String], received_at: Option<&str>, format: Format) -> Result<Prepared, String> {
    let record = match format {
        Format::Maildir => None,
        Format::Jmap => {
            let rec = build_record(mailbox_dir, uid, &raw, flags, received_at)?;
            blobs::put_as(root, &raw, rec.blob.clone())?;
            Some(rec)
        }
    };
    Ok(Prepared { root: root.to_path_buf(), uid, raw, record, server: None })
}

/// Writes `prepared` as its uid's copy in its format under `flags` (the flags
/// the uid has now), for a caller holding the mailbox lock. JMAP: the record
/// (`commit_record`: an existing record's server ids and `receivedAt` kept).
/// Maildir: the file goes in atomically, then every other Maildir name of the
/// uid is removed (`write`'s rule). Never touches the other format's copy and
/// checks nothing: a caller about to remove that copy verifies first
/// (`verify_prepared`).
pub fn commit(root: &Path, account_id: &str, mailbox: &str, prepared: &Prepared, flags: &[String]) -> Result<Entry, String> {
    commit_at(root, &mailbox_dir(root, account_id, mailbox), prepared, flags)
}

/// `commit` for the mailbox directory `mailbox_dir`, named as it is on disk
/// (`mailbox_dir_at`).
pub fn commit_at(root: &Path, mailbox_dir: &Path, prepared: &Prepared, flags: &[String]) -> Result<Entry, String> {
    let uid = prepared.uid;
    if let Some(rec) = &prepared.record {
        return commit_record(root, mailbox_dir, uid, rec, flags);
    }
    let dir = messages_in(mailbox_dir);
    let stale = leaf_names(&dir, uid);
    let entry = put(&dir, uid, &prepared.raw, flags)?;
    if unlink_stale(&dir, &entry.name, &stale) {
        warn!("message_store: an older copy of uid {uid} could not be removed");
    }
    Ok(entry)
}

/// `commit`, then `write_replacing`'s rules: when the mailbox holds the uid in
/// the other format too, the new copy is verified (`verify_prepared`) and the
/// other one removed; a copy that does not verify is removed again and the
/// error returned.
pub fn commit_replacing(root: &Path, account_id: &str, mailbox: &str, prepared: &Prepared, flags: &[String]) -> Result<Entry, String> {
    let uid = prepared.uid;
    let format = prepared.format();
    let entry = commit(root, account_id, mailbox, prepared, flags)?;
    let mailbox_path = mailbox_dir(root, account_id, mailbox);
    let other = other_format(format);
    if !holds_in(&mailbox_path, uid, other) {
        return Ok(entry);
    }
    if let Err(e) = verify_prepared(root, account_id, mailbox, prepared) {
        if let Err(undo) = drop_format_files(&mailbox_path, uid, format) {
            warn!("message_store: the unverified copy of uid {uid} could not be removed: {undo}");
        }
        return Err(format!("The new copy of uid {uid} did not verify: {e}"));
    }
    #[cfg(test)]
    let dropped = if FAIL_DROP_OTHER.with(|fail| fail.get()) { Err("removal refused by the test hook".to_string()) } else { drop_format_files(&mailbox_path, uid, other) };
    #[cfg(not(test))]
    let dropped = drop_format_files(&mailbox_path, uid, other);
    if let Err(e) = dropped {
        warn!("message_store: the other format's copy of uid {uid} could not be removed: {e}");
    }
    Ok(entry)
}

/// Re-reads the copy `commit` wrote for `prepared` and checks it holds the
/// prepared bytes, before anything else of the uid is removed: a record
/// re-parses, names the blob `prepare` hashed from those bytes, and that blob
/// exists and hashes to its id; a Maildir file re-reads as exactly the bytes.
/// The record arm hashes the stored blob once.
pub fn verify_prepared(root: &Path, account_id: &str, mailbox: &str, prepared: &Prepared) -> Result<(), String> {
    verify_prepared_at(root, &mailbox_dir(root, account_id, mailbox), prepared)
}

/// `verify_prepared` for the mailbox directory `mailbox_dir`, named as it is
/// on disk (`mailbox_dir_at`).
pub fn verify_prepared_at(root: &Path, mailbox_dir: &Path, prepared: &Prepared) -> Result<(), String> {
    let expected = match &prepared.record {
        Some(rec) => Expect::Record { blob: &rec.blob },
        None => Expect::File { raw: &prepared.raw },
    };
    verify_entry(root, mailbox_dir, prepared.uid, expected)
}

/// The prefix of a store error the disk itself gave (no space left, a quota,
/// an I/O error): the conversion job stops on one instead of skipping the
/// message.
pub const E_DISK: &str = "E_DISK";

/// `what: e`, prefixed `E_DISK: ` when the disk is full or failing.
pub(crate) fn io_failure(what: &str, e: &io::Error) -> String {
    // EIO has no `ErrorKind` of its own: its raw code is 5 on every unix.
    let eio = cfg!(unix) && e.raw_os_error() == Some(5);
    if eio || matches!(e.kind(), io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded) {
        format!("{E_DISK}: {what}: {e}")
    } else {
        format!("{what}: {e}")
    }
}

/// The format a `keep` of `format` removes.
fn other_format(format: Format) -> Format {
    match format {
        Format::Maildir => Format::Jmap,
        Format::Jmap => Format::Maildir,
    }
}

/// Whether the mailbox holds a JMAP record file for `uid`, whatever the
/// vault's format is now (a stat; the record is not read).
pub(crate) fn holds_record(root: &Path, account_id: &str, mailbox: &str, uid: u32) -> bool {
    holds_in(&mailbox_dir(root, account_id, mailbox), uid, Format::Jmap)
}

/// Whether the mailbox directory holds a file of `uid` in `format`, by name.
fn holds_in(mailbox_dir: &Path, uid: u32, format: Format) -> bool {
    match format {
        Format::Maildir => !leaf_names(&messages_in(mailbox_dir), uid).is_empty(),
        Format::Jmap => jmap_in(mailbox_dir).join(record_name(uid)).exists(),
    }
}

#[cfg(test)]
thread_local! {
    /// Test hook: makes `write_replacing`'s removal of the other format's copy fail on this thread.
    pub(crate) static FAIL_DROP_OTHER: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
thread_local! {
    /// Test hook: makes `verify_entry` fail on this thread.
    pub(crate) static FAIL_VERIFY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// What `verify_entry` checks the stored copy against.
enum Expect<'a> {
    /// The record names this blob id, and the blob's sha256 matches it.
    Record { blob: &'a str },
    /// The Maildir file re-reads as exactly these bytes.
    File { raw: &'a [u8] },
}

/// Re-reads `uid`'s stored copy and checks it is what `expected` names.
fn verify_entry(root: &Path, mailbox_dir: &Path, uid: u32, expected: Expect) -> Result<(), String> {
    #[cfg(test)]
    if FAIL_VERIFY.with(|fail| fail.get()) {
        return Err("verify refused by the test hook".to_string());
    }
    match expected {
        Expect::Record { blob } => verify_record(root, mailbox_dir, uid, Some(blob)),
        Expect::File { raw } => {
            let path = path_of(&messages_in(mailbox_dir), uid).ok_or_else(|| "the file is not there".to_string())?;
            let back = fs::read(&path).map_err(|e| format!("the file will not read back: {e}"))?;
            if back != raw {
                return Err("the file does not hold what was written".to_string());
            }
            Ok(())
        }
    }
}

/// `uid`'s record re-parses, names `expected_blob` when one is given, and the
/// blob it names exists and hashes to its id (`blobs::verify`: one read and
/// one sha256 of the stored file).
fn verify_record(root: &Path, mailbox_dir: &Path, uid: u32, expected_blob: Option<&str>) -> Result<(), String> {
    let rec = read_record(&jmap_in(mailbox_dir).join(record_name(uid))).map_err(|e| format!("the record will not read back: {e}"))?;
    if expected_blob.is_some_and(|blob| rec.blob != blob) {
        return Err("the record names another blob".to_string());
    }
    if !blobs::verify(root, &rec.blob)? {
        return Err("the blob is missing or damaged".to_string());
    }
    Ok(())
}

/// Removes `uid`'s files of `format` from the mailbox directory: its Maildir
/// files, or its record (never a blob: `sweep_blobs` judges blobs). Not its
/// decrypted copy, which serves the copy that stays. `Ok(true)` when a file
/// went; a file already gone is not an error.
fn drop_format_files(mailbox_dir: &Path, uid: u32, format: Format) -> Result<bool, String> {
    let paths: Vec<PathBuf> = match format {
        Format::Maildir => {
            let dir = messages_in(mailbox_dir);
            leaf_names(&dir, uid).into_iter().map(|leaf| dir.join(leaf)).collect()
        }
        Format::Jmap => vec![jmap_in(mailbox_dir).join(record_name(uid))],
    };
    let mut removed = false;
    for path in paths {
        match fs::remove_file(&path) {
            Ok(()) => removed = true,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_failure(&format!("Failed to remove {}", path.display()), &e)),
        }
    }
    Ok(removed)
}

/// Removes `uid`'s copy in the format other than `keep`: its Maildir files
/// when `keep` is `Jmap`, its record when `keep` is `Maildir` (never a blob).
/// For the conversion job. Refuses, removing nothing, when the mailbox holds
/// no copy of `uid` in `keep`, or when that copy does not verify here and now
/// as the message the other copy holds:
/// - `keep` of `Jmap`: the record re-parses and its blob exists and hashes to
///   its id (the Maildir copy is the only other holder of the bytes, so a
///   record whose blob is gone or damaged must not cost it);
/// - `keep` of `Maildir`: the Maildir file hashes to the blob id the record
///   names (the record goes, and with it the only name of its blob).
///
/// `Ok(true)` when a file went.
pub fn remove_other_format(root: &Path, account_id: &str, mailbox: &str, uid: u32, keep: Format) -> Result<bool, String> {
    remove_other_format_at(root, &mailbox_dir(root, account_id, mailbox), uid, keep)
}

/// `remove_other_format` for the mailbox directory `mailbox`, named as it is
/// on disk (`mailbox_dir_at`).
pub fn remove_other_format_at(root: &Path, mailbox: &Path, uid: u32, keep: Format) -> Result<bool, String> {
    match keep {
        Format::Jmap => {
            if record_of(mailbox, uid).map_err(|e| e.to_string())?.is_none() {
                return Err(format!("uid {uid} has no {keep:?} copy to keep"));
            }
            verify_record(root, mailbox, uid, None).map_err(|e| format!("uid {uid}: the record to keep did not verify: {e}"))?;
        }
        Format::Maildir => {
            let Some(file) = path_of(&messages_in(mailbox), uid) else {
                return Err(format!("uid {uid} has no {keep:?} copy to keep"));
            };
            if let Some((_, rec)) = record_of(mailbox, uid).map_err(|e| e.to_string())? {
                let raw = fs::read(&file).map_err(|e| format!("uid {uid}: the file to keep will not read: {e}"))?;
                if blobs::blob_id(&raw) != rec.blob {
                    return Err(format!("uid {uid}: the file to keep does not hold the record's message"));
                }
            }
        }
    }
    drop_format_files(mailbox, uid, other_format(keep))
}

// ── The conversion job's reads ───────────────────────────────────────────────

/// One uid's copy in one format, as the conversion job reads it: its flags,
/// its file, the message's size, and a stamp that changes whenever its bytes
/// may have. A Maildir file's stamp is its size and mtime, which a flag
/// rename keeps; a record's is its blob id, which a flag rewrite keeps.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Held {
    pub flags: Vec<String>,
    pub path: PathBuf,
    pub size: u64,
    pub stamp: String,
}

/// `uid`'s copy in `format` alone, whatever the other format holds. `None`
/// when there is none, or a record that will not read.
pub fn held_in(root: &Path, account_id: &str, mailbox: &str, uid: u32, format: Format) -> Option<Held> {
    held_at(&mailbox_dir(root, account_id, mailbox), uid, format)
}

/// `held_in` for the mailbox directory `mailbox_dir`, named as it is on disk
/// (`mailbox_dir_at`).
pub fn held_at(mailbox_dir: &Path, uid: u32, format: Format) -> Option<Held> {
    match format {
        Format::Maildir => {
            let path = path_of(&messages_in(mailbox_dir), uid)?;
            let meta = fs::metadata(&path).ok()?;
            let name = path.file_name()?.to_string_lossy().into_owned();
            let stamp = format!("{}:{}", meta.len(), mtime_ns(&meta));
            Some(Held { flags: parse_flags_from_filename(&name), path, size: meta.len(), stamp })
        }
        Format::Jmap => {
            let path = jmap_in(mailbox_dir).join(record_name(uid));
            let rec = read_record(&path).ok()?;
            Some(Held { flags: record::flags_of(&rec), path, size: rec.size, stamp: rec.blob })
        }
    }
}

/// `held_in` and the copy's bytes, read outside any lock: a Maildir file's own
/// bytes (stated before the read, so a rewrite in between shows as a changed
/// stamp under the lock), or a record's blob, refused as `InvalidData` when it
/// does not hash to the id the record names. `Ok(None)`: no such copy.
pub fn read_held(root: &Path, account_id: &str, mailbox: &str, uid: u32, format: Format) -> io::Result<Option<(Held, Vec<u8>)>> {
    read_held_at(root, &mailbox_dir(root, account_id, mailbox), uid, format)
}

/// `read_held` for the mailbox directory `mailbox_dir`, named as it is on disk
/// (`mailbox_dir_at`).
pub fn read_held_at(root: &Path, mailbox_dir: &Path, uid: u32, format: Format) -> io::Result<Option<(Held, Vec<u8>)>> {
    let Some(held) = held_at(mailbox_dir, uid, format) else { return Ok(None) };
    let raw = match format {
        Format::Maildir => match fs::read(&held.path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        },
        Format::Jmap => {
            let raw = blobs::get(root, &held.stamp)?;
            if blobs::blob_id(&raw) != held.stamp {
                return Err(io::Error::new(io::ErrorKind::InvalidData, format!("the blob of uid {uid} does not hash to its id")));
            }
            raw
        }
    };
    Ok(Some((held, raw)))
}

/// Whether `uid`'s Maildir file holds exactly the message its record names
/// (the file's sha256 is the record's blob id). `None` unless the mailbox
/// holds the uid in both formats and both read.
pub fn same_content(root: &Path, account_id: &str, mailbox: &str, uid: u32) -> Option<bool> {
    same_content_at(&mailbox_dir(root, account_id, mailbox), uid)
}

/// `same_content` for the mailbox directory `mailbox`, named as it is on disk
/// (`mailbox_dir_at`).
pub fn same_content_at(mailbox: &Path, uid: u32) -> Option<bool> {
    let (_, rec) = record_of(mailbox, uid).ok().flatten()?;
    let raw = fs::read(path_of(&messages_in(mailbox), uid)?).ok()?;
    Some(blobs::blob_id(&raw) == rec.blob)
}

/// The uids the mailbox holds a copy of in `format`, ascending, from one
/// names-only listing of that format's directory: a missing directory holds
/// none, a listing that fails is the error.
pub fn uids_in_format(root: &Path, account_id: &str, mailbox: &str, format: Format) -> io::Result<Vec<u32>> {
    uids_in_format_at(&mailbox_dir(root, account_id, mailbox), format)
}

/// `uids_in_format` for the mailbox directory `mailbox`, named as it is on
/// disk (`mailbox_dir_at`).
pub fn uids_in_format_at(mailbox: &Path, format: Format) -> io::Result<Vec<u32>> {
    let (dir, uid_of): (PathBuf, UidOf) = match format {
        Format::Maildir => (messages_in(mailbox), maildir::vault_filename_uid),
        Format::Jmap => (jmap_in(mailbox), record_uid),
    };
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut uids = Vec::new();
    for entry in entries {
        if let Some(uid) = uid_of(&entry?.file_name().to_string_lossy()) {
            uids.push(uid);
        }
    }
    uids.sort_unstable();
    uids.dedup();
    Ok(uids)
}

/// The bytes of the messages the vault holds in `format`: every Maildir
/// file's size, or every record's message size. What a conversion away from
/// `format` writes again.
pub fn stored_bytes(root: &Path, format: Format) -> io::Result<u64> {
    let mut total = 0;
    for account in dirs_in(&root.join("Maildir"))? {
        for mailbox in dirs_in(&account)? {
            total += match format {
                Format::Maildir => files_in(&messages_in(&mailbox), maildir::vault_filename_uid)?.iter().filter_map(|p| fs::metadata(p).ok()).map(|m| m.len()).sum::<u64>(),
                Format::Jmap => files_in(&jmap_in(&mailbox), record_uid)?.iter().filter_map(|p| read_record(p).ok()).map(|r| r.size).sum(),
            };
        }
    }
    Ok(total)
}

/// Whether the vault holds at least one message in `format`: a Maildir file
/// in a `cur/`, or a record in a `jmap/` that parses (a damaged record is no
/// message a conversion can move, `record_damaged_at`). Stops at the first
/// mailbox that holds one, so a vault wholly in the other format costs one
/// names-only listing of each mailbox's (empty or missing) directory of
/// `format`. A listing that fails is the error.
pub fn holds_format(root: &Path, format: Format) -> io::Result<bool> {
    for account in dirs_in(&root.join("Maildir"))? {
        for mailbox in dirs_in(&account)? {
            let found = match format {
                Format::Maildir => !files_in(&messages_in(&mailbox), maildir::vault_filename_uid)?.is_empty(),
                Format::Jmap => files_in(&jmap_in(&mailbox), record_uid)?.iter().any(|path| read_record(path).is_ok()),
            };
            if found {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Whether `uid`'s record in the mailbox directory is there but will not
/// parse: a damaged record, which every reader passes over (`record_of`),
/// the sweep reads for blob ids (`mark_ids_in`) and the conversion job
/// leaves as it is.
pub fn record_damaged_at(mailbox_dir: &Path, uid: u32) -> bool {
    matches!(read_record(&jmap_in(mailbox_dir).join(record_name(uid))), Err(e) if e.kind() == io::ErrorKind::InvalidData)
}

/// The directories in `dir` (not a dot name, not a link); none when it is missing.
fn dirs_in(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_dir() && !entry.file_name().to_string_lossy().starts_with('.') {
            out.push(entry.path());
        }
    }
    Ok(out)
}

/// The files in `dir` whose name carries a uid by `uid_of`; none when it is missing.
fn files_in(dir: &Path, uid_of: UidOf) -> io::Result<Vec<PathBuf>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry?;
        if uid_of(&entry.file_name().to_string_lossy()).is_some() {
            out.push(entry.path());
        }
    }
    Ok(out)
}

/// The vault's mailboxes by their on-disk names, `(account dir, mailbox
/// dir)`, sorted: every directory two levels under `Maildir/` (dot names and
/// links left out) that holds a message directory of either format.
pub fn mailbox_dirs(root: &Path) -> io::Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    for account in dirs_in(&root.join("Maildir"))? {
        for mailbox in dirs_in(&account)? {
            // A directory without either message directory is no mailbox; one
            // that cannot be looked into is an error, never an empty folder.
            match has_message_dir(&mailbox) {
                Ok(true) => {
                    let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    out.push((name(&account), name(&mailbox)));
                }
                Ok(false) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(io::Error::new(e.kind(), format!("could not look into {}: {e}", mailbox.display()))),
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Keeps `uid`'s files in `format` under `dest`, at the path each has below
/// the mailbox directory (`dest/cur/<name>`, `dest/jmap/<uid>.json`): a hard
/// link when `link` and the volume allows one, else a copy. Removes nothing
/// from the mailbox; a file an earlier try already kept there is replaced.
/// Returns how many it kept.
pub fn retire_format(root: &Path, account_id: &str, mailbox: &str, uid: u32, format: Format, dest: &Path, link: bool) -> Result<usize, String> {
    retire_format_at(&mailbox_dir(root, account_id, mailbox), uid, format, dest, link)
}

/// `retire_format` for the mailbox directory `mailbox`, named as it is on
/// disk (`mailbox_dir_at`).
pub fn retire_format_at(mailbox: &Path, uid: u32, format: Format, dest: &Path, link: bool) -> Result<usize, String> {
    let files: Vec<PathBuf> = match format {
        Format::Maildir => {
            let dir = messages_in(mailbox);
            leaf_names(&dir, uid).into_iter().map(|leaf| dir.join(leaf)).collect()
        }
        Format::Jmap => Some(jmap_in(mailbox).join(record_name(uid))).filter(|p| p.is_file()).into_iter().collect(),
    };
    let mut kept = 0;
    for src in files {
        let rel = src.strip_prefix(mailbox).map_err(|e| e.to_string())?;
        let to = dest.join(rel);
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(|e| io_failure(&format!("Failed to create {}", parent.display()), &e))?;
        }
        match fs::remove_file(&to) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_failure(&format!("Failed to replace {}", to.display()), &e)),
        }
        if !(link && fs::hard_link(&src, &to).is_ok()) {
            fs::copy(&src, &to).map_err(|e| io_failure(&format!("Failed to keep {} aside", src.display()), &e))?;
        }
        kept += 1;
    }
    Ok(kept)
}

/// Re-file `uid` under the flags `flags` names. `Ok(None)`: the mailbox holds
/// no file for `uid`. The entry is the file after the change (unchanged when
/// the name already matched). A record is rewritten in place
/// (`set_record_flags`); a Maildir file is renamed.
pub fn set_flags(root: &Path, account_id: &str, mailbox: &str, uid: u32, flags: &[String]) -> Result<Option<Entry>, String> {
    let mailbox = mailbox_dir(root, account_id, mailbox);
    if let Some((path, _)) = record_of(&mailbox, uid).map_err(|e| format!("Failed to read the message record: {e}"))? {
        return set_record_flags(&path, uid, flags).map(|(entry, _)| Some(entry));
    }
    let Some(old) = path_of(&messages_in(&mailbox), uid) else { return Ok(None) };
    rename_onto(&old, uid, flags).map(Some)
}

/// Removes every file of `uid` (both formats; never deletes blobs), and its
/// decrypted copy. Returns whether one was removed.
pub fn remove(root: &Path, account_id: &str, mailbox: &str, uid: u32) -> Result<bool, String> {
    let mailbox = mailbox_dir(root, account_id, mailbox);
    let dir = messages_in(&mailbox);
    let mut removed = false;
    for leaf in leaf_names(&dir, uid) {
        match unlink(&dir.join(&leaf), uid) {
            Ok(()) => removed = true,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Failed to delete .eml file: {}", e)),
        }
    }
    match unlink(&jmap_in(&mailbox).join(record_name(uid)), uid) {
        Ok(()) => removed = true,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Failed to delete the message record: {}", e)),
    }
    Ok(removed)
}

/// The file a zero-copy copier (mirror, zip) reads `uid` from: a blob path in
/// JMAP format. `None` when the mailbox holds no file for it.
pub fn raw_path(root: &Path, account_id: &str, mailbox: &str, uid: u32) -> Option<PathBuf> {
    let mailbox = mailbox_dir(root, account_id, mailbox);
    if let Ok(Some((_, rec))) = record_of(&mailbox, uid) {
        return Some(blobs::blob_path(root, &rec.blob));
    }
    path_of(&messages_in(&mailbox), uid)
}

/// `uid`'s decrypted copy (`pgp`'s `.decrypted/<uid>.eml` in the mailbox
/// directory), when there is one made from exactly `original`.
pub fn read_decrypted_copy(root: &Path, account_id: &str, mailbox: &str, uid: u32, original: &[u8]) -> Option<Vec<u8>> {
    crate::pgp::read_copy(&messages_dir(root, account_id, mailbox), uid, original)
}

/// Keeps `decrypted` as `uid`'s decrypted copy, beside the message: never a
/// second message, since no listing reads `.decrypted/`. The caller holds the
/// mailbox's write lock.
pub fn write_decrypted_copy(root: &Path, account_id: &str, mailbox: &str, uid: u32, decrypted: &[u8]) -> Result<(), String> {
    crate::pgp::write_copy(&messages_dir(root, account_id, mailbox), uid, decrypted)
}

/// Records `uid`'s server ids (a JMAP account's `emailId`, `blobId`,
/// `threadId`): `server` in its record, and the record's `email.id` and
/// `email.threadId` follow them (`put_server_ids`). Returns the record's path
/// when it was rewritten, for the caller's registry row (`reflag`: its mtime
/// moved). `None`, nothing written: the uid has no record (a Maildir copy
/// keeps no server ids) or the record already holds these ids. The caller
/// holds the mailbox's write lock.
pub fn set_server_ids(root: &Path, account_id: &str, mailbox: &str, uid: u32, ids: record::ServerIds) -> Result<Option<PathBuf>, String> {
    let Some((path, rec)) = record_of(&mailbox_dir(root, account_id, mailbox), uid).map_err(|e| format!("Failed to read the message record: {e}"))? else {
        return Ok(None);
    };
    let mut new = rec.clone();
    put_server_ids(&mut new, ids);
    if new == rec {
        return Ok(None);
    }
    let json = serde_json::to_vec(&new).map_err(|e| format!("Failed to encode the message record: {e}"))?;
    crate::fsx::write_atomic(&path, &json).map_err(|e| format!("Failed to rewrite the message record: {e}"))?;
    Ok(Some(path))
}

/// What one `sweep_blobs` pass found and did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SweepStats {
    /// Records read in the mark walk.
    pub records: usize,
    /// Of those, records that would not parse or named no blob: every blob id
    /// in their text was kept (`mark_ids_in`).
    pub damaged: usize,
    /// Blob files looked at.
    pub blobs: usize,
    /// Unreferenced blobs left because they are younger than `min_age`.
    pub young: usize,
    /// Blobs removed.
    pub removed: usize,
    /// Bytes the removed blobs held.
    pub freed_bytes: u64,
}

/// Mark and sweep of `<root>/message_blobs`, the only way a blob is ever
/// deleted. Holds no lock: a vault-wide walk under the write gate would stall
/// every foreground read for its whole length.
///
/// 1. Mark: every `Maildir/<account>/<dir>/jmap/<uid>.json` is read and its
///    blob id kept. A record that reads but will not parse as JSON, or names
///    no blob, has every blob id in its text kept instead (`mark_ids_in`):
///    no blob it may name goes, and the record stays where it is. A record
///    that will not read stops the pass with an error, removing nothing. So
///    does a partial listing: a vault with blobs and no `Maildir/`, an
///    account or mailbox directory that vanished or cannot be stated, or a
///    mailbox whose `jmap/` is unreadable. Only a directory that exists may
///    be empty.
/// 2. Sweep: each blob not marked is stated again and removed only when its
///    mtime is still older than `min_age`.
///
/// Why that is safe with writers running: the touch-before-name rule. A
/// writer makes the blob young (`blobs::put` for an existing blob,
/// `blobs::touch` in `rebind_uids`) before any record names it, and a new
/// blob is young, so a blob a write reuses or adds, or a record that appears
/// under a new name the mark walk had not listed, never names an old blob
/// (`write_record` writes no record when that refresh fails). Any new writer
/// of a record must keep the rule. A record removed during the walk only
/// keeps its blob until the next pass. Refcounts are never
/// stored: the vault registry is per host and droppable, and a vault on a NAS
/// is shared by hosts.
pub fn sweep_blobs(root: &Path, min_age: std::time::Duration) -> Result<SweepStats, String> {
    let mut stats = SweepStats::default();
    let mut marked: HashSet<String> = HashSet::new();
    let unlisted = |dir: &Path, e: io::Error| format!("could not list {}: {e}", dir.display());
    // `absent_ok`: a directory that is not there lists as empty (the blob
    // store of a vault with no messages); the mark walk never allows it.
    let list = |dir: &Path, absent_ok: bool| -> Result<Vec<PathBuf>, String> {
        match fs::read_dir(dir) {
            Ok(entries) => entries.map(|e| e.map(|e| e.path()).map_err(|e| unlisted(dir, e))).collect(),
            Err(e) if absent_ok && e.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(unlisted(dir, e)),
        }
    };
    // A stat that fails is an error, never "not a directory".
    let is_dir = |path: &Path| -> Result<bool, String> {
        fs::metadata(path).map(|m| m.is_dir()).map_err(|e| format!("sweep stopped: could not stat {}: {e}", path.display()))
    };
    let maildir = root.join("Maildir");
    if !maildir.exists() && root.join(blobs::BLOB_DIR).exists() {
        return Err(format!("sweep stopped: {} is missing while message_blobs exists", maildir.display()));
    }
    if maildir.exists() {
        for account in list(&maildir, false)? {
            if !is_dir(&account)? {
                continue;
            }
            for mailbox in list(&account, false)? {
                if is_dir(&mailbox)? {
                    mark_mailbox(&mailbox, &mut marked, &mut stats)?;
                }
            }
        }
    }
    let now = SystemTime::now();
    for shard in list(&root.join(blobs::BLOB_DIR), true)? {
        if !is_dir(&shard)? {
            continue;
        }
        for path in list(&shard, true)? {
            let Some(hex) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".eml")).map(str::to_owned) else { continue };
            let id = format!("sha256-{hex}");
            if !blobs::is_valid_id(&id) {
                continue;
            }
            stats.blobs += 1;
            if marked.contains(&id) {
                continue;
            }
            // Stated now, after the walk: a put during it made the blob young.
            let Ok(meta) = fs::metadata(&path) else { continue };
            let age = meta.modified().ok().and_then(|m| now.duration_since(m).ok()).unwrap_or_default();
            if age < min_age {
                stats.young += 1;
                continue;
            }
            match fs::remove_file(&path) {
                Ok(()) => {
                    stats.removed += 1;
                    stats.freed_bytes += meta.len();
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => warn!("sweep_blobs: {} could not be removed: {e}", path.display()),
            }
        }
    }
    Ok(stats)
}

/// The mark step for one mailbox: reads every record under its `jmap/` and
/// adds each blob id to `marked`.
fn mark_mailbox(mailbox: &Path, marked: &mut HashSet<String>, stats: &mut SweepStats) -> Result<(), String> {
    let entries = match fs::read_dir(jmap_in(mailbox)) {
        Ok(entries) => entries,
        // No `jmap/` is "no records" only while the mailbox directory is
        // there: a mailbox renamed since the account was listed has records.
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return match fs::metadata(mailbox) {
                Ok(meta) if meta.is_dir() => Ok(()),
                Ok(_) => Err(format!("sweep stopped: {} is not a directory", mailbox.display())),
                Err(e) => Err(format!("sweep stopped: the mailbox {} is gone or unreadable: {e}", mailbox.display())),
            };
        }
        Err(e) => return Err(format!("could not list {}: {e}", jmap_in(mailbox).display())),
    };
    for entry in entries {
        let path = entry.map_err(|e| format!("could not list {}: {e}", jmap_in(mailbox).display()))?.path();
        if path.file_name().is_none_or(|n| record_uid(&n.to_string_lossy()).is_none()) {
            continue;
        }
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("sweep stopped: the record {} will not read: {e}", path.display())),
        };
        let blob = serde_json::from_slice::<Value>(&bytes).ok().and_then(|value| value.get("blob").and_then(Value::as_str).map(str::to_owned));
        match blob {
            Some(blob) => {
                marked.insert(blob);
            }
            None => {
                warn!("sweep_blobs: the record {} will not parse or names no blob; every blob id in it is kept", path.display());
                mark_ids_in(&bytes, marked);
                stats.damaged += 1;
            }
        }
        stats.records += 1;
    }
    Ok(())
}

/// Marks every well-formed blob id in `text` (`sha256-` then 64 lowercase
/// hex digits, `blobs::is_valid_id`), read as bytes: a damaged record may
/// not even be UTF-8. Marking too much only keeps a blob longer.
fn mark_ids_in(text: &[u8], marked: &mut HashSet<String>) {
    const PREFIX: &[u8] = b"sha256-";
    const ID_LEN: usize = PREFIX.len() + 64;
    let mut at = 0;
    while let Some(found) = text.get(at..).and_then(|rest| rest.windows(PREFIX.len()).position(|w| w == PREFIX)) {
        let start = at + found;
        if let Some(id) = text.get(start..start + ID_LEN).and_then(|id| std::str::from_utf8(id).ok()) {
            if blobs::is_valid_id(id) {
                marked.insert(id.to_string());
            }
        }
        at = start + PREFIX.len();
    }
}

/// Removes the blob store's empty directories, then the store itself once
/// it is empty: `remove_dir` only, so a blob, or anything else in it, is
/// never removed. For a vault in Maildir format, where no writer puts a
/// blob (the daemon's `reclaim`, under its registry lock): Settings offers
/// Reclaim while the store is there (`has_blob_store`).
pub fn prune_blob_store(root: &Path) {
    let store = root.join(blobs::BLOB_DIR);
    for shard in fs::read_dir(&store).into_iter().flatten().flatten() {
        if shard.file_type().is_ok_and(|t| t.is_dir()) {
            let _ = fs::remove_dir(shard.path());
        }
    }
    let _ = fs::remove_dir(&store);
}

/// Turns every record of the mailbox directory back into a Maildir file (its
/// blob's bytes under its flags), each verified before its record goes: for a
/// pass that works on Maildir files by name across a whole mailbox (the
/// generation repair). A uid's Maildir files are replaced by the record's
/// copy, as the record is the one every reader read. Never removes a blob.
/// Returns how many records went; the first failure stops the pass (the
/// record stays, so nothing is lost).
pub(crate) fn demote_records(mailbox_dir: &Path) -> Result<usize, String> {
    let root = root_of(mailbox_dir);
    let dir = messages_in(mailbox_dir);
    let mut demoted = 0;
    for (uid, path) in record_paths_at(mailbox_dir) {
        let rec = read_record(&path).map_err(|e| format!("the record {} will not read: {e}", path.display()))?;
        let raw = blobs::get(root, &rec.blob).map_err(|e| format!("the blob of uid {uid} will not read: {e}"))?;
        let stale = leaf_names(&dir, uid);
        let entry = put(&dir, uid, &raw, &record::flags_of(&rec))?;
        unlink_stale(&dir, &entry.name, &stale);
        verify_entry(root, mailbox_dir, uid, Expect::File { raw: &raw })?;
        fs::remove_file(&path).map_err(|e| format!("the record {} could not be removed: {e}", path.display()))?;
        demoted += 1;
    }
    Ok(demoted)
}

// ── Archive and Archive & delete ─────────────────────────────────────────────
//
// The archive runs, the Archive & delete job and custody take one listing of a
// folder and then work file by file against it, so a 300k folder stays linear.
// These keep exactly the `maildir` rules those callers used on `cur/`.

/// `raw_path` for a caller that listed the mailbox earlier (`raw_paths_at`,
/// `archived_paths`): `listed` while that file is still there, else one rescan
/// by uid (`maildir::find_listed_by_uid`). A flag change renames a file after
/// the listing; a caller never asks for a uid its listing lacked.
///
/// A listed record or blob path resolves by uid (`raw_path`: its record's
/// blob, else its Maildir file); a listed Maildir path gone with no Maildir
/// file of the uid left resolves to the uid's record, if it has one.
pub fn raw_path_listed(root: &Path, account_id: &str, mailbox: &str, uid: u32, listed: &Path) -> Option<PathBuf> {
    if is_record_path(listed) || is_blob_path(listed) {
        return raw_path(root, account_id, mailbox, uid);
    }
    let mailbox = mailbox_dir(root, account_id, mailbox);
    maildir::find_listed_by_uid(&messages_in(&mailbox), uid, listed)
        .or_else(|| record_of(&mailbox, uid).ok().flatten().map(|(_, rec)| blobs::blob_path(root, &rec.blob)))
}

/// The path of the entry `name` (an `Entry.name`, or a vault registry row's
/// name) in the mailbox. No disk access: the file need not exist. A record
/// name is its record (`listed_path`).
pub fn entry_path(root: &Path, account_id: &str, mailbox: &str, name: &str) -> PathBuf {
    listed_path(&mailbox_dir(root, account_id, mailbox), name)
}

/// The `Entry.name` a write of `uid` under `flags` gives in the vault's
/// format: a record's `<uid>.json`, else the Maildir name (`entry_name`).
pub fn stored_name(root: &Path, uid: u32, flags: &[String]) -> String {
    match vault_format(root) {
        Format::Jmap => record_name(uid),
        Format::Maildir => entry_name(uid, flags),
    }
}

/// The name a copy of the listed file `src` of `uid` takes outside the vault
/// (the backup mirror): a blob's is the Maildir name of its uid under its
/// record's flags (`maildir::mirror_filename`), any other file's its own.
/// `None` for a blob whose record will not read.
pub fn copy_name(root: &Path, account_id: &str, mailbox: &str, uid: u32, src: &Path) -> Option<String> {
    if !is_blob_path(src) && !is_record_path(src) {
        return src.file_name().map(|n| n.to_string_lossy().into_owned());
    }
    let (_, rec) = record_of(&mailbox_dir(root, account_id, mailbox), uid).ok().flatten()?;
    Some(maildir::mirror_filename(uid, &record::flags_of(&rec)))
}

/// The archived records of the mailbox directory by uid: `(record path,
/// record)` for each that reads and carries `local.archived`.
fn archived_records(mailbox_dir: &Path) -> HashMap<u32, (PathBuf, record::Record)> {
    record_paths_at(mailbox_dir)
        .into_iter()
        .filter_map(|(uid, path)| {
            let rec = read_record(&path).ok()?;
            rec.local.archived.then_some((uid, (path, rec)))
        })
        .collect()
}

/// Every archived copy (`A` in its name) the mailbox holds, keyed by uid, from
/// one listing (`maildir::archived_file_map`): a uid with a working-cache copy
/// beside an archived one maps to the archived one. An archived record
/// (`local.archived`) maps to its record path, over any Maildir file.
pub fn archived_paths(root: &Path, account_id: &str, mailbox: &str) -> HashMap<u32, PathBuf> {
    let mailbox = mailbox_dir(root, account_id, mailbox);
    let mut map = maildir::archived_file_map(&messages_in(&mailbox));
    map.extend(archived_records(&mailbox).into_iter().map(|(uid, (path, _))| (uid, path)));
    map
}

/// The name of an archived copy of `uid`, by one listing of the mailbox: for a
/// mailbox the vault registry could not verify. A uid with a record answers by
/// the record alone: `<uid>.json` when it is archived, else `None`.
pub fn archived_name(root: &Path, account_id: &str, mailbox: &str, uid: u32) -> Option<String> {
    let mailbox = mailbox_dir(root, account_id, mailbox);
    if let Some((_, rec)) = record_of(&mailbox, uid).ok().flatten() {
        return rec.local.archived.then(|| record_name(uid));
    }
    fs::read_dir(messages_in(&mailbox))
        .ok()?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .find(|n| maildir::vault_filename_uid(n) == Some(uid) && maildir::carries_archived(n))
}

/// Whether the entry `name` (a registry row's name) of the mailbox is an
/// archived copy: `A` in a Maildir name, `local.archived` in a record.
pub fn is_archived_entry(root: &Path, account_id: &str, mailbox: &str, name: &str) -> bool {
    match record_uid(name) {
        Some(_) => read_record(&entry_path(root, account_id, mailbox, name)).is_ok_and(|rec| rec.local.archived),
        None => maildir::carries_archived(name),
    }
}

/// One uid's outcome in a verify of archived copies.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Verdict {
    Verified,
    Missing,
    Mismatched,
}

/// The verdicts of the uids of `uids` that have an archived record in
/// `records`, by the rules of `maildir::verify_listed` (`strict: false`) or
/// `maildir::verify_listed_strict`: the Message-ID read from the blob against
/// `expected_ids`.
fn verify_records(
    root: &Path,
    records: &HashMap<u32, (PathBuf, record::Record)>,
    uids: &[u32],
    expected_ids: Option<&HashMap<u32, String>>,
    strict: bool,
) -> HashMap<u32, Verdict> {
    let mut out = HashMap::new();
    for uid in uids {
        let Some((_, rec)) = records.get(uid) else { continue };
        // The copy is the blob: a record whose blob is gone, unreadable or
        // does not hash to its id is not a copy, whatever Message-ID is asked.
        if !matches!(blobs::verify(root, &rec.blob), Ok(true)) {
            out.insert(*uid, Verdict::Missing);
            continue;
        }
        let want = expected_ids.and_then(|m| m.get(uid)).map(|id| maildir::normalize_message_id(id)).filter(|id| !id.is_empty());
        let Some(want) = want else {
            out.insert(*uid, Verdict::Verified);
            continue;
        };
        let blob = blobs::blob_path(root, &rec.blob);
        let verdict = match maildir::read_message_id(&blob) {
            Some(got) if got == want => Verdict::Verified,
            Some(_) => Verdict::Mismatched,
            None if !strict => Verdict::Verified,
            None if blob.is_file() => Verdict::Mismatched,
            None => Verdict::Missing,
        };
        out.insert(*uid, verdict);
    }
    out
}

/// Merges the record uids' verdicts with a Maildir verify's split of the
/// rest, in `uids`' order.
fn merge_verified(uids: &[u32], mut verdicts: HashMap<u32, Verdict>, maildir: (Vec<u32>, Vec<u32>, Vec<u32>)) -> (Vec<u32>, Vec<u32>, Vec<u32>) {
    let (verified, missing, mismatched) = maildir;
    for (set, verdict) in [(verified, Verdict::Verified), (missing, Verdict::Missing), (mismatched, Verdict::Mismatched)] {
        for uid in set {
            verdicts.entry(uid).or_insert(verdict);
        }
    }
    let mut out = (Vec::new(), Vec::new(), Vec::new());
    for uid in uids {
        match verdicts.get(uid) {
            Some(Verdict::Verified) => out.0.push(*uid),
            Some(Verdict::Missing) => out.1.push(*uid),
            Some(Verdict::Mismatched) => out.2.push(*uid),
            None => {}
        }
    }
    out
}

/// Which of `uids` the mailbox holds an archived copy of, as `(verified,
/// missing, mismatched)` by `maildir::verify_copies`' rules. A uid with an
/// archived record is judged by it (its Message-ID read from the blob); a
/// uid whose record is not archived counts as missing, as a cache copy does.
pub fn verify_archived(
    root: &Path,
    account_id: &str,
    mailbox: &str,
    uids: &[u32],
    expected_ids: Option<&HashMap<u32, String>>,
) -> (Vec<u32>, Vec<u32>, Vec<u32>) {
    let mailbox = mailbox_dir(root, account_id, mailbox);
    let records = archived_records(&mailbox);
    let held = record_paths_at(&mailbox);
    if held.is_empty() {
        return maildir::verify_copies(&messages_in(&mailbox), uids, expected_ids);
    }
    let rest: Vec<u32> = uids.iter().copied().filter(|uid| !held.contains_key(uid)).collect();
    let mut judged = verify_records(root, &records, uids, expected_ids, false);
    // A record that is not archived: no archived copy, as with a cache file.
    for uid in uids.iter().filter(|uid| held.contains_key(uid)) {
        judged.entry(*uid).or_insert(Verdict::Missing);
    }
    merge_verified(uids, judged, maildir::verify_copies(&messages_in(&mailbox), &rest, expected_ids))
}

/// `verify_archived` against a listing an earlier `archived_paths` took, by
/// `maildir::verify_listed_strict`'s rules: for a caller about to delete the
/// server's copy. A listed record is judged by the record read now (it must
/// still be archived), its Message-ID read from its blob.
pub fn verify_archived_strict(
    root: &Path,
    account_id: &str,
    mailbox: &str,
    listing: &HashMap<u32, PathBuf>,
    uids: &[u32],
    expected_ids: &HashMap<u32, String>,
) -> (Vec<u32>, Vec<u32>, Vec<u32>) {
    let mailbox = mailbox_dir(root, account_id, mailbox);
    let listed_records: Vec<u32> = uids.iter().copied().filter(|uid| listing.get(uid).is_some_and(|p| is_record_path(p))).collect();
    if listed_records.is_empty() {
        return maildir::verify_listed_strict(&messages_in(&mailbox), listing, uids, expected_ids);
    }
    let records = archived_records(&mailbox);
    let rest: Vec<u32> = uids.iter().copied().filter(|uid| !listed_records.contains(uid)).collect();
    let mut judged = verify_records(root, &records, &listed_records, Some(expected_ids), true);
    for uid in &listed_records {
        judged.entry(*uid).or_insert(Verdict::Missing);
    }
    merge_verified(uids, judged, maildir::verify_listed_strict(&messages_in(&mailbox), listing, &rest, expected_ids))
}

/// Re-files copies under the uids a move gave their messages
/// (`maildir::rebind_uids`): the `(old, new)` pairs renamed. The caller
/// invalidates the mailbox's registry rows when any moved. A record of `old`
/// is rewritten as the record of `new` (its `uid` and local `email.id` follow)
/// when `new` holds no copy in either format, then the old record goes.
pub fn rebind_uids(root: &Path, account_id: &str, mailbox: &str, pairs: &[(u32, u32)]) -> Vec<(u32, u32)> {
    let mailbox = mailbox_dir(root, account_id, mailbox);
    let mut records = record_paths_at(&mailbox);
    let (record_pairs, file_pairs): (Vec<_>, Vec<_>) =
        pairs.iter().copied().partition(|(old, _)| records.contains_key(old));
    let file_pairs: Vec<(u32, u32)> = file_pairs.into_iter().filter(|(_, new)| !records.contains_key(new)).collect();
    let mut rebound = maildir::rebind_uids(&messages_in(&mailbox), &file_pairs);
    let maildir_held = maildir_paths_at(&mailbox);
    for (old, new) in record_pairs {
        if old == new || records.contains_key(&new) || maildir_held.contains_key(&new) {
            continue;
        }
        let Some(path) = records.remove(&old) else { continue };
        let target = jmap_in(&mailbox).join(record_name(new));
        let moved = (|| -> Result<(), String> {
            let mut rec = read_record(&path).map_err(|e| e.to_string())?;
            rec.uid = new;
            if rec.server.is_none() {
                if let Some(email) = rec.email.as_object_mut() {
                    let local = format!("L{new}-{}", &rec.blob["sha256-".len().."sha256-".len() + 12]);
                    email.insert("id".into(), Value::String(local));
                }
            }
            let json = serde_json::to_vec(&rec).map_err(|e| e.to_string())?;
            // Touch before name (`sweep_blobs`): a sweep that listed `old`
            // before this rebind never sees `new`, so its blob is young.
            blobs::touch(root, &rec.blob)?;
            crate::fsx::write_atomic(&target, &json).map_err(|e| e.to_string())?;
            fs::remove_file(&path).map_err(|e| e.to_string())
        })();
        match moved {
            Ok(()) => {
                records.insert(new, target);
                rebound.push((old, new));
            }
            Err(e) => {
                warn!("rebind_uids: record {old} -> {new} failed: {e}");
                records.insert(old, path);
            }
        }
    }
    rebound
}

/// Makes the directory `write_new` writes the mailbox's messages into.
pub fn create_messages_dir(root: &Path, account_id: &str, mailbox: &str) -> io::Result<()> {
    fs::create_dir_all(messages_dir(root, account_id, mailbox))
}

/// Writes `raw` as a new file of `uid` under the name `flags` builds, into the
/// directory `create_messages_dir` made, and returns its path. Removes
/// nothing: another file of `uid` stays where it is. `atomic`: through a temp
/// file and a rename (`fsx::write_atomic`), so a failure leaves nothing
/// behind; otherwise one plain `fs::write` (the backup runners'), which can
/// leave a partial file, so the caller invalidates the folder on an error.
///
/// In a JMAP vault: `uid`'s record and blob (`write_record`, always atomic),
/// and the record's path.
pub fn write_new(root: &Path, account_id: &str, mailbox: &str, uid: u32, raw: &[u8], flags: &[String], atomic: bool) -> io::Result<PathBuf> {
    if vault_format(root) == Format::Jmap {
        let mailbox = mailbox_dir(root, account_id, mailbox);
        write_record(root, &mailbox, uid, raw, flags).map_err(io::Error::other)?;
        return Ok(jmap_in(&mailbox).join(record_name(uid)));
    }
    let path = messages_dir(root, account_id, mailbox).join(vault_files::build_maildir_filename(uid, flags));
    if atomic {
        crate::fsx::write_atomic(&path, raw)?;
    } else {
        fs::write(&path, raw)?;
    }
    Ok(path)
}

/// Removes the file an earlier listing gave for `uid` (`raw_path_listed`'s
/// rule), if one is still there. A failure is ignored: the caller writes the
/// uid's new copy next. A listed record or blob removes the uid's record,
/// never a blob.
pub fn remove_listed(root: &Path, account_id: &str, mailbox: &str, uid: u32, listed: &Path) {
    if is_record_path(listed) || is_blob_path(listed) {
        let _ = drop_format_files(&mailbox_dir(root, account_id, mailbox), uid, Format::Jmap);
        return;
    }
    if let Some(existing) = raw_path_listed(root, account_id, mailbox, uid, listed) {
        let _ = fs::remove_file(&existing);
    }
}

// ── Backup mirror copies and flag passes ─────────────────────────────────────

/// The file to copy to the backup mirror per wanted uid, from one listing of
/// the mailbox: an archived copy (`A`) wins over a working-cache copy of the
/// same uid; otherwise the first file `read_dir` returns. A folder that will
/// not list holds none.
///
/// A uid with a record maps to its record path, over any Maildir file
/// (`raw_path_listed` reads its blob, `copy_name` names its copy).
pub fn archived_first_paths(root: &Path, account_id: &str, mailbox: &str, wanted: &HashSet<u32>) -> HashMap<u32, PathBuf> {
    let mut out = archived_first_files(root, account_id, mailbox, wanted);
    out.extend(record_paths_at(&mailbox_dir(root, account_id, mailbox)).into_iter().filter(|(uid, _)| wanted.contains(uid)));
    out
}

/// `archived_first_paths` of the Maildir message directory alone.
fn archived_first_files(root: &Path, account_id: &str, mailbox: &str, wanted: &HashSet<u32>) -> HashMap<u32, PathBuf> {
    let mut found: HashMap<u32, (PathBuf, bool)> = HashMap::new();
    let Ok(entries) = fs::read_dir(messages_dir(root, account_id, mailbox)) else { return Default::default() };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(uid) = maildir::vault_filename_uid(&name) else { continue };
        if !wanted.contains(&uid) {
            continue;
        }
        let archived = maildir::carries_archived(&name);
        // Keep what is held unless this file is archived and the held one is not.
        let keep = match found.get(&uid) {
            Some((_, held_archived)) => *held_archived || !archived,
            None => false,
        };
        if !keep {
            found.insert(uid, (entry.path(), archived));
        }
    }
    found.into_iter().map(|(uid, (path, _))| (uid, path)).collect()
}

/// Every file of the mailbox keyed by uid by the mirror's loose rule
/// (`maildir::mirror_file_map`: legacy `12.eml` and `12_S.eml` names too), from
/// one listing, the first file per uid: what a pass that changes the flags of
/// many uids re-files with `set_flags_at`.
///
/// A uid with a record maps to its record path (`set_flags_at` rewrites it).
pub(crate) fn flag_paths(root: &Path, account_id: &str, mailbox: &str) -> HashMap<u32, PathBuf> {
    let mut map = maildir::mirror_file_map(&messages_dir(root, account_id, mailbox));
    map.extend(record_paths_at(&mailbox_dir(root, account_id, mailbox)));
    map
}

// ── Mailbox-directory level, for the derived stores ──────────────────────────
//
// The search index and the vault registry key a mailbox by the directory's
// name on disk (`vault_dir`), read back from `read_dir` or from their own
// rows. That name need not survive `vault_dir_name` unchanged (an NFD name
// read back from an HFS+ or SMB volume has combining marks it would rewrite),
// so these take the mailbox directory itself instead of a mailbox name.

/// `<maildir_root>/<account dir>/<vault_dir>`: the mailbox directory named by
/// its on-disk name, which is used as is.
pub fn mailbox_dir_at(maildir_root: &Path, account_id: &str, vault_dir: &str) -> PathBuf {
    vault_files::account_dir(maildir_root, account_id).join(vault_dir)
}

/// Whether the mailbox directory holds a message directory (Maildir `cur/` or
/// JMAP `jmap/`): `Ok(true)` when either is a directory, else a stat's error
/// that is not `NotFound` (the Maildir one first), else `Ok(false)` for
/// anything else at either name, and `NotFound` when neither is there: the
/// mailbox holds no messages and never did.
pub fn has_message_dir(mailbox_dir: &Path) -> io::Result<bool> {
    let maildir = fs::metadata(messages_in(mailbox_dir)).map(|meta| meta.is_dir());
    if matches!(maildir, Ok(true)) {
        return maildir;
    }
    let records = fs::metadata(jmap_in(mailbox_dir)).map(|meta| meta.is_dir());
    if matches!(records, Ok(true)) {
        return records;
    }
    match (maildir, records) {
        (Err(e), _) if e.kind() != io::ErrorKind::NotFound => Err(e),
        (_, Err(e)) if e.kind() != io::ErrorKind::NotFound => Err(e),
        (Ok(false), _) | (_, Ok(false)) => Ok(false),
        (maildir, _) => maildir,
    }
}

/// One result out of a Maildir directory's and a JMAP directory's: `NotFound`
/// only when both are missing, any other error of either (the Maildir one
/// first), else both joined, a missing one as empty.
fn either_dir<T: Default>(maildir: io::Result<T>, records: io::Result<T>, join: impl FnOnce(T, T) -> T) -> io::Result<T> {
    let missing = |r: &io::Result<T>| matches!(r, Err(e) if e.kind() == io::ErrorKind::NotFound);
    match (maildir, records) {
        (Err(e), _) if e.kind() != io::ErrorKind::NotFound => Err(e),
        (_, Err(e)) if e.kind() != io::ErrorKind::NotFound => Err(e),
        (maildir, records) if missing(&maildir) && missing(&records) => maildir,
        (maildir, records) => Ok(join(maildir.unwrap_or_default(), records.unwrap_or_default())),
    }
}

/// One strict listing of a mailbox's messages, for a store that reconciles its
/// rows against it (the search index, the vault registry).
#[derive(Debug, Default)]
pub struct Scan {
    /// One entry per uid, by uid: the first file `read_dir` returned for it
    /// that would stat.
    pub entries: Vec<Entry>,
    /// The uids of files whose stat failed (typically a flag rename between
    /// `read_dir` and the stat): still held under another name, so their rows
    /// must not be removed.
    pub unstatted: BTreeSet<u32>,
}

/// Disk only. Lists the mailbox directory `mailbox_dir` by the strict reader
/// rule (`maildir::vault_filename_uid`).
///
/// Unlike `list`, nothing is papered over:
/// - The message directory's own `read_dir` error is returned with its kind, so
///   a caller tells `NotFound` (no messages yet) from an unreadable folder.
/// - An error mid-iteration ends the listing (the Unix `ReadDir` stops after
///   one), so it is the whole listing's error, never a shorter folder:
///   `flatten()` here once turned a truncated listing into verified truth that
///   pruned every row after the break. It is re-kinded to `Other`, because a
///   caller reads `NotFound` as "no messages", which is only true of the
///   `read_dir` open. (Not injectable in a test: there is no way to fail
///   `readdir` part-way on a real directory.)
/// - A file that will not stat is in `unstatted`, not an entry of size 0.
///
/// Both formats (`either_dir`'s errors): every record that stats and reads,
/// its `Entry` a record entry, wins over a Maildir file of its uid. A record
/// that will not stat is in `unstatted`; one that will not read or parse is
/// left out (logged), so a Maildir file of its uid is the entry instead.
pub fn scan_dir(mailbox_dir: &Path) -> io::Result<Scan> {
    let maildir = scan_messages(&messages_in(mailbox_dir));
    let records = scan_records(&jmap_in(mailbox_dir));
    let (held, unstatted) = either_dir(maildir, records, |(mut held, mut unstatted), (records, unread)| {
        for (uid, entry) in records {
            unstatted.remove(&uid);
            held.insert(uid, entry);
        }
        unstatted.extend(unread.into_iter().filter(|uid| !held.contains_key(uid)));
        (held, unstatted)
    })?;
    let mut entries: Vec<Entry> = held.into_values().collect();
    entries.sort_by_key(|e| e.uid);
    Ok(Scan { entries, unstatted })
}

/// `scan_dir`'s pass over a Maildir message directory: one entry per uid (the
/// first file that stats) and the uids whose stat failed.
fn scan_messages(dir: &Path) -> io::Result<(HashMap<u32, Entry>, BTreeSet<u32>)> {
    let listing = fs::read_dir(dir)?;
    let mut held: HashMap<u32, Entry> = HashMap::new();
    let mut unstatted = BTreeSet::new();
    for item in listing {
        let item = item.map_err(io::Error::other)?;
        let name = item.file_name().to_string_lossy().into_owned();
        let Some(uid) = maildir::vault_filename_uid(&name) else { continue };
        let Ok(meta) = item.metadata() else {
            unstatted.insert(uid);
            continue;
        };
        held.entry(uid).or_insert_with(|| entry_of(uid, name, Some(meta)));
    }
    Ok((held, unstatted))
}

/// `scan_dir`'s pass over a JMAP record directory: every record that stats
/// and reads, and the uids of records whose stat failed. A record gone since
/// the listing is neither.
fn scan_records(dir: &Path) -> io::Result<(HashMap<u32, Entry>, BTreeSet<u32>)> {
    let listing = fs::read_dir(dir)?;
    let mut held: HashMap<u32, Entry> = HashMap::new();
    let mut unstatted = BTreeSet::new();
    for item in listing {
        let item = item.map_err(io::Error::other)?;
        let Some(uid) = record_uid(&item.file_name().to_string_lossy()) else { continue };
        let path = item.path();
        match fs::metadata(&path) {
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => {
                unstatted.insert(uid);
                continue;
            }
        }
        match record_entry(uid, &path) {
            Ok(entry) => {
                held.insert(uid, entry);
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => warn!("message_store: record {} will not read: {e}", path.display()),
        }
    }
    Ok((held, unstatted))
}

/// How many files of the mailbox directory carry a uid, counted from
/// `read_dir` alone: no stat, no dedupe, entries that fail to read skipped. A
/// cheap upper bound on what `scan_dir` will find, for a progress total.
/// Both formats, with `either_dir`'s errors.
pub fn count_files(mailbox_dir: &Path) -> io::Result<usize> {
    let count = |dir: PathBuf, uid_of: UidOf| {
        fs::read_dir(dir).map(|listing| listing.flatten().filter(|e| uid_of(&e.file_name().to_string_lossy()).is_some()).count())
    };
    either_dir(count(messages_in(mailbox_dir), maildir::vault_filename_uid), count(jmap_in(mailbox_dir), record_uid), |a, b| a + b)
}

/// Disk only. The entry for `uid` in the mailbox directory `mailbox_dir`, or
/// `None` when it holds no file for it (`find`'s rule).
pub fn find_at(mailbox_dir: &Path, uid: u32) -> Option<Entry> {
    if let Ok(entry) = record_entry(uid, &jmap_in(mailbox_dir).join(record_name(uid))) {
        return Some(entry);
    }
    let path = path_of(&messages_in(mailbox_dir), uid)?;
    let name = path.file_name()?.to_string_lossy().into_owned();
    Some(entry_of(uid, name, fs::metadata(&path).ok()))
}

/// The readable bytes of the entry `name` (of `uid`) that a `scan_dir` or
/// `find_at` of `mailbox_dir` returned: its decrypted copy when there is one
/// (`pgp::readable`), so an encrypted message is indexed and shown in clear.
/// No rescan: a name gone since the listing (a flag rename) is `NotFound`.
/// A name that can never be read as a file is `IsADirectory` or
/// `NotADirectory`. On Windows, opening a directory with `File::open` fails
/// with neither kind, so a failed read whose path is a directory is re-kinded
/// to `IsADirectory`. Any other error may pass (permissions, a flaky drive).
///
/// A record entry (`<uid>.json`) reads as its blob's bytes, with the same
/// decrypted-copy rule and the same error kinds: the record or its blob gone
/// is `NotFound`, a record that will not parse is `InvalidData`.
pub fn read_listed(mailbox_dir: &Path, uid: u32, name: &str) -> io::Result<Vec<u8>> {
    let dir = messages_in(mailbox_dir);
    if record_uid(name).is_some() {
        let path = jmap_in(mailbox_dir).join(name);
        let rec = match read_record(&path) {
            Err(e) if path.is_dir() => return Err(io::Error::new(io::ErrorKind::IsADirectory, e)),
            other => other?,
        };
        return Ok(crate::pgp::readable(&dir, uid, blobs::get(root_of(mailbox_dir), &rec.blob)?));
    }
    let path = dir.join(name);
    match fs::read(&path) {
        Ok(raw) => Ok(crate::pgp::readable(&dir, uid, raw)),
        Err(e) if matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::IsADirectory | io::ErrorKind::NotADirectory) => Err(e),
        Err(e) if path.is_dir() => Err(io::Error::new(io::ErrorKind::IsADirectory, e)),
        Err(e) => Err(e),
    }
}

/// The flags `Entry.flags` holds for an entry named `name`. For a derived
/// store that kept only `Entry.name` (a search index row) and must answer
/// with the flags it was listed under. A record's name holds none: read
/// `flags_name` of it instead.
pub fn flags_in_name(name: &str) -> Vec<String> {
    parse_flags_from_filename(name)
}

/// The name a reader takes a listed entry's flags from (`flags_in_name`):
/// a Maildir entry's own `name`, unchanged; for a record (`<uid>.json`, a name
/// holding no flags) the Maildir name of its uid under `letters`, the
/// `flag_letters` of its `Entry.flags` that the vault registry and the search
/// index keep beside the name. The one rule for every reader that keeps names.
pub fn flags_name(name: &str, letters: &str) -> String {
    match record_uid(name) {
        Some(uid) => entry_name(uid, &letters.chars().map(String::from).collect::<Vec<_>>()),
        None => name.to_string(),
    }
}

/// `flags_in_name(flags_name(name, letters))`: the flags of a listed entry
/// whose name and flag letters a derived store kept.
pub fn listed_flags(name: &str, letters: &str) -> Vec<String> {
    flags_in_name(&flags_name(name, letters))
}

/// The flag letters (`ADFRST`) `flags` names, in `flags`' order, as the search
/// index stores them. Takes what `Entry.flags` holds and what a writer passes
/// (`seen` or `s`, any case); a flag no letter carries (`\Seen`) adds none.
pub fn flag_letters(flags: &[String]) -> String {
    flags.iter().filter_map(|f| vault_files::flag_letter(f)).collect()
}

/// The `Entry.name` a Maildir entry of `uid` under `flags` carries, for a
/// derived store's row of a message no file holds yet (a header-only row).
pub fn entry_name(uid: u32, flags: &[String]) -> String {
    vault_files::build_maildir_filename(uid, flags)
}

/// A mailbox's uid space read once, for a uid allocator: what `uids` counts,
/// and the held copies a reader finds by uid.
#[derive(Debug, Default)]
pub struct UidSpace {
    /// Every uid a file carries (`uids`' set): the message directory, the JMAP
    /// records and `orphaned/`, by the loose rule.
    pub taken: BTreeSet<u32>,
    /// uid -> its held copy: its record (`jmap/<uid>.json`) when it has one,
    /// else the file `raw_path` finds for it in the message directory by the
    /// strict rule (`maildir::vault_filename_uid`), the first file `read_dir`
    /// returned for the uid. `message_id_at` reads the Message-ID of either.
    pub held: HashMap<u32, PathBuf>,
}

/// Disk only. The `UidSpace` of the mailbox directory `mailbox_dir`, from one
/// listing of each directory, with `uids`' errors: a missing directory is
/// empty, any other listing failure is an error that names the directory.
pub fn uid_space_at(mailbox_dir: &Path) -> io::Result<UidSpace> {
    let mut space = UidSpace::default();
    for (taken, uid, path) in taken_files_at(mailbox_dir)? {
        space.taken.insert(uid);
        match taken {
            Taken::Orphaned => {}
            // Listed after the message directory: a record wins over a Maildir file.
            Taken::Record => {
                space.held.insert(uid, path);
            }
            Taken::Message => {
                if let Some(held) = path.file_name().and_then(|name| maildir::vault_filename_uid(&name.to_string_lossy())) {
                    space.held.entry(held).or_insert(path);
                }
            }
        }
    }
    Ok(space)
}

/// Every held uid's file (`raw_path`'s file) in the mailbox directory
/// `mailbox_dir`, from one listing: the first file `read_dir` returns per
/// uid, no stat. Lenient, for a reader that walks a whole folder: a directory
/// that is missing or will not list is empty, and an entry that will not
/// read is skipped. A uid with a record that reads maps to its blob.
pub fn raw_paths_at(mailbox_dir: &Path) -> HashMap<u32, PathBuf> {
    let mut map = maildir::uid_file_map(&messages_in(mailbox_dir));
    add_record_blobs(&mut map, mailbox_dir);
    map
}

/// Maps each uid with a record that reads in the mailbox directory to its
/// blob, over whatever `map` held for it.
fn add_record_blobs(map: &mut HashMap<u32, PathBuf>, mailbox_dir: &Path) {
    let root = root_of(mailbox_dir);
    for (uid, path) in record_paths_at(mailbox_dir) {
        if let Ok(rec) = read_record(&path) {
            map.insert(uid, blobs::blob_path(root, &rec.blob));
        }
    }
}

/// `raw_paths_at` of the Maildir message directory alone: for a pass that
/// renames or sets aside Maildir files by name (the import rehome), which a
/// blob must never reach.
pub(crate) fn maildir_paths_at(mailbox_dir: &Path) -> HashMap<u32, PathBuf> {
    maildir::uid_file_map(&messages_in(mailbox_dir))
}

/// The Maildir message directory of the mailbox directory `mailbox_dir`, for
/// a pass that reads, re-checks or renames Maildir files by name as a whole
/// directory: the import rehome, the backup pre-sync and status counts (the
/// `*_in` helpers below), and `vault_flags::Dirs` (whose parent a mailbox
/// rename moves). Every other caller asks by uid.
pub(crate) fn maildir_messages_dir(mailbox_dir: &Path) -> PathBuf {
    messages_in(mailbox_dir)
}

// ── Path-level helpers for `vault_files` ─────────────────────────────────────
//
// `vault_files` resolves the file itself (registry row first, then a scan)
// and does the registry bookkeeping around these; the uid-level functions
// above resolve by scanning.

/// Every leaf name in the message directory `dir` that carries `uid`
/// (`maildir::vault_filename_uid`'s rule). A directory that will not list is
/// empty, as `vault_files::store`'s sweep always read it.
pub(crate) fn leaf_names(dir: &Path, uid: u32) -> Vec<String> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| maildir::vault_filename_uid(name) == Some(uid))
        .collect()
}

/// The path of the listed entry `name` (an `Entry.name`, or a vault registry
/// row's name) in the mailbox directory `mailbox_dir`: a record name in
/// `jmap/`, any other in the Maildir message directory. No disk access.
pub(crate) fn listed_path(mailbox_dir: &Path, name: &str) -> PathBuf {
    if record_uid(name).is_some() {
        jmap_in(mailbox_dir).join(name)
    } else {
        messages_in(mailbox_dir).join(name)
    }
}

/// The file of `uid` a writer holding the mailbox's lock acts on, by one
/// lookup and no parse: its record when there is one, else its Maildir file
/// (`find_by_uid`'s rule).
pub(crate) fn held_path(mailbox_dir: &Path, uid: u32) -> Option<PathBuf> {
    let record = jmap_in(mailbox_dir).join(record_name(uid));
    if record.is_file() {
        return Some(record);
    }
    path_of(&messages_in(mailbox_dir), uid)
}

/// The entry of the listed file `path` (of `uid`) as `scan_dir` lists it: a
/// record's entry, or a Maildir file's name, stat and flags. `None` when it
/// will not stat, or is a record that will not read.
pub(crate) fn entry_at(path: &Path, uid: u32) -> Option<Entry> {
    if is_record_path(path) {
        return record_entry(uid, path).ok();
    }
    let name = path.file_name()?.to_string_lossy().into_owned();
    let meta = fs::metadata(path).ok()?;
    Some(entry_of(uid, name, Some(meta)))
}

/// After `unlink(path, uid)` of one listed file: removes `uid`'s copy in the
/// other format too (`drop_format_files`), so a delete leaves no copy a
/// listing would bring back. Never a blob.
pub(crate) fn unlink_other_format(path: &Path, uid: u32) -> Result<(), String> {
    let Some(mailbox_dir) = path.parent().and_then(Path::parent) else { return Ok(()) };
    let other = if is_record_path(path) { Format::Maildir } else { Format::Jmap };
    drop_format_files(mailbox_dir, uid, other).map(|_| ())
}

/// Write `raw` atomically into `dir` under the name `flags` builds for `uid`,
/// creating `dir` first. Removes nothing.
pub(crate) fn put(dir: &Path, uid: u32, raw: &[u8], flags: &[String]) -> Result<Entry, String> {
    fs::create_dir_all(dir).map_err(|e| io_failure("Failed to create Maildir directory", &e))?;
    let name = vault_files::build_maildir_filename(uid, flags);
    let path = dir.join(&name);
    crate::fsx::write_atomic(&path, raw).map_err(|e| io_failure("Failed to write .eml file", &e))?;
    let meta = fs::metadata(&path).ok();
    Ok(entry_of(uid, name, meta))
}

/// Remove every leaf of `stale` from `dir` except `keep`. A leaf already gone
/// counts as removed. Returns whether one is still there.
pub(crate) fn unlink_stale(dir: &Path, keep: &str, stale: &[String]) -> bool {
    let mut left = false;
    for old in stale {
        if old.as_str() == keep {
            continue;
        }
        match fs::remove_file(dir.join(old)) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(_) => left = true,
        }
    }
    left
}

/// Rename the file `old` (of `uid`) onto the name `flags` builds, in the same
/// directory. No rename when the name already matches. Returns the entry
/// after the change.
pub(crate) fn rename_onto(old: &Path, uid: u32, flags: &[String]) -> Result<Entry, String> {
    let name = vault_files::build_maildir_filename(uid, flags);
    let new = old.with_file_name(&name);
    if new != old {
        fs::rename(old, &new).map_err(|e| format!("Failed to rename file: {}", e))?;
    }
    let meta = fs::metadata(&new).ok();
    Ok(entry_of(uid, name, meta))
}

/// Remove the file `path` (of `uid`), then its decrypted copy beside the
/// directory: plaintext must not outlive the original. A record's decrypted
/// copy is the same `.decrypted/<uid>.eml` (`pgp::copy_path` takes the
/// directory's parent, the mailbox directory, for `cur/` and `jmap/` alike).
pub(crate) fn unlink(path: &Path, uid: u32) -> io::Result<()> {
    fs::remove_file(path)?;
    if let Some(dir) = path.parent() {
        crate::pgp::remove_copy(dir, uid);
    }
    Ok(())
}

/// The bytes of a file a caller already resolved for one uid (the vault
/// registry's row), with the name its flags read off (`flags_name`): a
/// Maildir file's own name; for a record, its blob's bytes and the Maildir
/// name of its uid under its flags. A record or blob gone is `NotFound`.
pub(crate) fn read_at(root: &Path, path: &Path) -> io::Result<(String, Vec<u8>)> {
    if is_record_path(path) {
        let rec = read_record(path)?;
        let raw = blobs::get(root, &rec.blob)?;
        return Ok((entry_name(rec.uid, &record::flags_of(&rec)), raw));
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    fs::read(path).map(|raw| (name, raw))
}

/// Re-file the listed file `path` of `uid` under the flags `flags_for` makes
/// of the ones its name holds now (`Entry.flags`). `Ok(Some(name))`: renamed to
/// `name`; `Ok(None)`: the name already said this. One rename, no rescan: for
/// a pass that listed the mailbox once (`flag_paths`). A record is rewritten
/// in place from its own flags (`set_record_flags`): `Ok(Some("<uid>.json"))`
/// when they changed.
pub(crate) fn set_flags_at(path: &Path, uid: u32, flags_for: impl FnOnce(&[String]) -> Vec<String>) -> Result<Option<String>, String> {
    if is_record_path(path) {
        let current = record_flags_at(path).ok_or_else(|| format!("Failed to read the message record {}", path.display()))?;
        let (entry, changed) = set_record_flags(path, uid, &flags_for(&current))?;
        return Ok(changed.then_some(entry.name));
    }
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let current = parse_flags_from_filename(&name);
    let new_name = vault_files::build_maildir_filename(uid, &flags_for(&current));
    if new_name == name {
        return Ok(None);
    }
    fs::rename(path, path.with_file_name(&new_name)).map_err(|e| e.to_string())?;
    Ok(Some(new_name))
}

// ── Maildir message-directory passes, for the backup pre-sync ────────────────
//
// The pre-sync and the backup status read and fill a mailbox's Maildir message
// directory as a whole, by name, against the mirror's (`backup::sync_locations`,
// `copy_to_backup`, `scan_cur_uids`). They take that directory
// (`maildir_messages_dir`), as the import rehome does.

/// Every uid a file in the Maildir message directory `dir` carries, by the
/// mirror's loose rule (legacy names too). A directory that is not there holds
/// none; one that will not list is an error.
///
/// The JMAP records beside `dir` count too (by name).
pub(crate) fn loose_uids_in(dir: &Path) -> Result<HashSet<u32>, String> {
    let records: Vec<u32> = dir.parent().map(|mailbox| record_paths_at(mailbox).into_keys().collect()).unwrap_or_default();
    let mut uids = loose_file_uids_in(dir)?;
    uids.extend(records);
    Ok(uids)
}

/// Uids named in one external mirror message directory, using its legacy
/// filename rule. Lists only this directory, never sibling JMAP records.
/// An open error retains its kind; an entry error is always Other, so a
/// caller cannot mistake a truncated listing for a missing, empty mailbox.
pub(crate) fn mirror_uids_in(dir: &Path) -> io::Result<HashSet<u32>> {
    let mut uids = HashSet::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry.map_err(io::Error::other)?;
        if let Some(uid) = maildir::mirror_filename_uid(&entry.file_name().to_string_lossy()) {
            uids.insert(uid);
        }
    }
    Ok(uids)
}

/// `loose_uids_in` of the Maildir message directory alone.
fn loose_file_uids_in(dir: &Path) -> Result<HashSet<u32>, String> {
    if !dir.exists() {
        return Ok(HashSet::new());
    }

    let mut uids = HashSet::new();
    let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read Maildir cur dir: {}", e))?;

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // Filename format: "<uid>:<flags>.eml" or "<uid>.eml" or "<uid>_<flags>.eml"
        if let Some(uid) = maildir::mirror_filename_uid(&name) {
            uids.insert(uid);
        }
    }

    Ok(uids)
}

/// The files of the Maildir message directory `dir` a mirror copy is made
/// from: `(uid, name, path)` for every entry that is not a directory and whose
/// name carries a uid by the mirror's loose rule, in `read_dir` order. A
/// directory that will not list holds none.
///
/// A JMAP record beside `dir` is a source too, as `(uid, the Maildir name of
/// its uid under its flags, its blob)`, and a Maildir file of its uid is not.
pub(crate) fn mirror_sources_in(dir: &Path) -> Vec<(u32, String, PathBuf)> {
    let records: Vec<(u32, String, PathBuf)> = match dir.parent() {
        Some(mailbox) => record_paths_at(mailbox)
            .into_iter()
            .filter_map(|(uid, path)| {
                let rec = read_record(&path).ok()?;
                Some((uid, maildir::mirror_filename(uid, &record::flags_of(&rec)), blobs::blob_path(root_of(mailbox), &rec.blob)))
            })
            .collect(),
        None => Vec::new(),
    };
    let held: HashSet<u32> = records.iter().map(|(uid, _, _)| *uid).collect();
    let mut out: Vec<(u32, String, PathBuf)> =
        maildir::mirror_files(dir).into_iter().filter(|(uid, _, path)| !path.is_dir() && !held.contains(uid)).collect();
    out.extend(records);
    out
}

/// `raw_paths_at` of the Maildir message directory `dir` itself, plus the
/// blobs of the JMAP records beside it.
pub(crate) fn raw_paths_in(dir: &Path) -> HashMap<u32, PathBuf> {
    let mut map = maildir::uid_file_map(dir);
    if let Some(mailbox) = dir.parent() {
        add_record_blobs(&mut map, mailbox);
    }
    map
}

/// Copies the file `src` into the Maildir message directory `dir` as `uid`
/// under the name `flags` builds (a restore from the mirror). Removes nothing.
/// In a JMAP vault it is written as `uid`'s record and blob instead
/// (`write_record`); the count is the bytes copied either way.
pub(crate) fn copy_in(dir: &Path, uid: u32, flags: &[String], src: &Path) -> io::Result<u64> {
    if let Some(mailbox) = dir.parent() {
        let root = root_of(mailbox);
        if vault_format(root) == Format::Jmap {
            let raw = fs::read(src)?;
            write_record(root, mailbox, uid, &raw, flags).map_err(io::Error::other)?;
            return Ok(raw.len() as u64);
        }
    }
    fs::copy(src, dir.join(vault_files::build_maildir_filename(uid, flags)))
}

// ── Import, export and restore ───────────────────────────────────────────────
//
// The mbox and backup ZIP exports, the mbox import's allocator and dedupe, and
// the IMAP restore walk a mailbox's Maildir message directory as a whole, by
// file name, each by its own rule. They take the mailbox directory
// (`mailbox_dir`, or `mailbox_dir_at` for one named by its on-disk name).

/// The uid a file name starts with by the loosest rule: the digits before the
/// first info separator or `.` (`12:2,S.eml`, `12;2,S.eml` and a legacy
/// `12.eml` all name 12; `12_S.eml` and a dot-prefixed temp name none).
fn leading_uid(name: &str) -> Option<u32> {
    name.split(|c| maildir::is_info_sep(c) || c == '.').next()?.parse().ok()
}

/// Every uid the files of the mailbox directory `mailbox_dir` are named for,
/// by `leading_uid`'s rule, one per file in `read_dir` order, directories
/// included: for the mbox import's allocator, which never hands out a uid a
/// file name already carries. One lazy listing of the message directory; a
/// directory that is missing or will not list names none, and an entry that
/// will not read is skipped.
///
/// Every JMAP record name counts too.
pub fn named_uids_at(mailbox_dir: &Path) -> impl Iterator<Item = u32> {
    let files = fs::read_dir(messages_in(mailbox_dir)).into_iter().flatten().flatten().filter_map(|entry| leading_uid(&entry.file_name().to_string_lossy()));
    files.chain(record_paths_at(mailbox_dir).into_keys())
}

/// Every regular file of the mailbox directory `mailbox_dir` that
/// `leading_uid` reads a uid from, as `(uid, name, path)` in `read_dir` order:
/// what a restore uploads. One lazy listing of the message directory; a
/// directory that is missing or will not list holds none, and an entry that
/// will not read, or whose type will not read, is skipped.
///
/// A JMAP record is `(uid, the name its flags read off, its blob)`
/// (`listed_message`), and a Maildir file of its uid is left out.
pub fn named_files_at(mailbox_dir: &Path) -> impl Iterator<Item = (u32, String, PathBuf)> {
    let records: Vec<(u32, String, PathBuf)> =
        record_paths_at(mailbox_dir).into_values().filter_map(|path| listed_message(&path)).map(|(uid, blob, name)| (uid, name, blob)).collect();
    let held: HashSet<u32> = records.iter().map(|(uid, _, _)| *uid).collect();
    let files = fs::read_dir(messages_in(mailbox_dir)).into_iter().flatten().flatten().filter_map(move |entry| {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            return None;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let uid = leading_uid(&name)?;
        (!held.contains(&uid)).then(|| (uid, name, entry.path()))
    });
    files.chain(records)
}

/// Every file of the mailbox directory `mailbox_dir` whose name carries a
/// Maildir info part (`maildir::has_info`), as `(name, path)` in `read_dir`
/// order: what an mbox or backup ZIP export copies, and what an mbox import
/// reads Message-IDs from. One lazy listing of the message directory; a
/// directory that is missing or will not list holds none, and an entry that
/// will not read is skipped.
///
/// A JMAP record is `(the name its flags read off, its blob)` (an `.eml` name
/// with an info part), and a Maildir file of its uid is left out.
pub fn info_files_at(mailbox_dir: &Path) -> impl Iterator<Item = (String, PathBuf)> {
    let records: Vec<(u32, PathBuf, String)> = record_paths_at(mailbox_dir).into_values().filter_map(|path| listed_message(&path)).collect();
    let held: HashSet<u32> = records.iter().map(|(uid, _, _)| *uid).collect();
    let files = fs::read_dir(messages_in(mailbox_dir)).into_iter().flatten().flatten().filter_map(move |entry| {
        let name = entry.file_name().to_string_lossy().to_string();
        let shadowed = maildir::vault_filename_uid(&name).is_some_and(|uid| held.contains(&uid));
        (maildir::has_info(&name) && !shadowed).then(|| (name, entry.path()))
    });
    files.chain(records.into_iter().map(|(_, blob, name)| (name, blob)))
}

/// `create_messages_dir` of the mailbox directory `mailbox_dir`, used as is.
pub fn create_messages_dir_at(mailbox_dir: &Path) -> io::Result<()> {
    fs::create_dir_all(messages_in(mailbox_dir))
}

/// `entry_path` in the mailbox directory `mailbox_dir`. No disk access: the
/// file need not exist. In a JMAP vault a name that carries a uid
/// (`uid_in_name`) is that uid's record, where `write_named_at` writes it.
pub fn entry_path_at(mailbox_dir: &Path, name: &str) -> PathBuf {
    if let Some(uid) = uid_in_name(name).filter(|_| vault_format(root_of(mailbox_dir)) == Format::Jmap) {
        return jmap_in(mailbox_dir).join(record_name(uid));
    }
    messages_in(mailbox_dir).join(name)
}

/// Writes `raw` as the entry `name` of the mailbox directory `mailbox_dir`,
/// exactly as named (a backup ZIP's entry, which need not carry a uid), into
/// the directory `create_messages_dir_at` made, and returns its path. One
/// plain `fs::write`: it overwrites a file already under `name` and can leave
/// a partial file on an error, so the caller checks first and invalidates the
/// folder after a failure. Removes nothing else.
///
/// In a JMAP vault a name that carries a uid is written as that uid's record
/// and blob, under the flags the name holds (`write_record`, atomic), and the
/// record's path returned. A name with no uid has no record form: it lands as
/// named.
pub fn write_named_at(mailbox_dir: &Path, name: &str, raw: &[u8]) -> io::Result<PathBuf> {
    let root = root_of(mailbox_dir);
    if let Some(uid) = uid_in_name(name).filter(|_| vault_format(root) == Format::Jmap) {
        write_record(root, mailbox_dir, uid, raw, &flags_in_name(name)).map_err(io::Error::other)?;
        return Ok(jmap_in(mailbox_dir).join(record_name(uid)));
    }
    let path = entry_path_at(mailbox_dir, name);
    fs::write(&path, raw)?;
    Ok(path)
}

/// The uid the entry name `name` carries by the strict reader rule
/// (`maildir::vault_filename_uid`), `None` for a name no listing reads a uid
/// from: whether a file written under `name` is a message the vault registry
/// keeps a row for.
pub fn uid_in_name(name: &str) -> Option<u32> {
    maildir::vault_filename_uid(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::maildir::INFO_PREFIX;

    const ACCT: &str = "acct";
    const MBOX: &str = "INBOX";

    fn flags(f: &[&str]) -> Vec<String> {
        f.iter().map(|s| s.to_string()).collect()
    }

    /// Runs `f` once per format, each in a temp vault of its own whose marker
    /// names that format. A behaviour that holds in one format only fails here.
    fn run_both(f: impl Fn(&Path, Format)) {
        for format in [Format::Maildir, Format::Jmap] {
            eprintln!("run_both: {format:?}");
            let tmp = tempfile::tempdir().unwrap();
            set_vault_format(tmp.path(), format).unwrap();
            f(tmp.path(), format);
        }
    }

    /// The storage counters count a mailbox's messages as `list_at` lists
    /// them, and the bytes of every file that is there.
    #[test]
    fn storage_stats_disk_usage_counts_what_the_listing_lists() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let raw = |id: &str| format!("Subject: {id}\r\n\r\n{id}\r\n").into_bytes();
        for (uid, id) in [(1, "one"), (2, "two"), (3, "three")] {
            write(root, ACCT, MBOX, uid, &raw(id), &[]).unwrap();
        }
        set_vault_format(root, Format::Jmap).unwrap();
        write(root, ACCT, MBOX, 1, &raw("one"), &[]).unwrap();
        write(root, ACCT, MBOX, 4, &raw("four"), &[]).unwrap();
        // A record that will not parse: its uid's Maildir file is the message.
        let dir = mailbox_dir(root, ACCT, MBOX);
        fs::write(dir.join("jmap/3.json"), b"{not json").unwrap();

        let usage = disk_usage(std::slice::from_ref(&dir));
        assert_eq!(usage.messages as usize, list_at(&dir).unwrap().len());
        assert_eq!(usage.messages, 4);
        let len = |p: PathBuf| fs::metadata(p).unwrap().len();
        let files: u64 = ["one", "two", "three"].iter().map(|id| raw(id).len() as u64).sum();
        let records = len(dir.join("jmap/1.json")) + len(dir.join("jmap/4.json")) + 9;
        let blobs = (raw("one").len() + raw("four").len()) as u64;
        assert_eq!(usage.bytes, files + records + blobs);
        assert_eq!(disk_usage(&[root.join("Maildir/acct/Nope")]), DiskUsage::default());
    }

    /// The `Entry.name` of `uid`'s copy in `format` under the flag `letters`.
    fn leaf(format: Format, uid: u32, letters: &str) -> String {
        match format {
            Format::Maildir => format!("{uid}{INFO_PREFIX}{letters}.eml"),
            Format::Jmap => format!("{uid}.json"),
        }
    }

    /// The Task 1 behaviour tests, each a fn of the vault root and its format.
    const STORE_BEHAVIOURS: [fn(&Path, Format); 6] = [
        round_trips,
        set_flags_reports_new_flags,
        remove_deletes_every_copy,
        missing_mailbox_is_empty,
        uids_include_orphaned,
        header_section_stops_at_blank_line,
    ];

    #[test]
    fn every_store_test_passes_in_both_formats() {
        for behaviour in STORE_BEHAVIOURS {
            run_both(behaviour);
        }
    }

    #[test]
    fn write_then_find_then_read_round_trips() {
        run_both(round_trips);
    }

    fn round_trips(root: &Path, format: Format) {
        assert_eq!(vault_format(root), format);
        assert_eq!(serde_json::to_string(&Format::Jmap).unwrap(), "\"jmap\"");
        assert_eq!(serde_json::from_str::<Format>("\"maildir\"").unwrap(), Format::Maildir);

        let raw = b"Message-ID: <seven@x.test>\r\nSubject: seven\r\n\r\nbody".to_vec();
        // `build_maildir_filename` takes `seen`/`archived` (or the letters);
        // a `\\Seen` system flag names no letter.
        let written = write(root, ACCT, MBOX, 7, &raw, &flags(&["seen", "archived"])).unwrap();
        assert_eq!(written.name, leaf(format, 7, "AS"));

        let found = find(root, ACCT, MBOX, 7).expect("uid 7 is held");
        assert_eq!(found, written);
        assert_eq!(found.uid, 7);
        assert_eq!(found.flags, flags(&["archived", "seen", "\\Seen"]));
        assert_eq!(found.size, raw.len() as u64);
        assert!(found.mtime_ns > 0, "a written file has an mtime");
        assert_eq!(read_raw(root, ACCT, MBOX, 7).unwrap(), Some(raw.clone()));
        let copied_from = match format {
            Format::Maildir => messages_dir(root, ACCT, MBOX).join(&found.name),
            Format::Jmap => blobs::blob_path(root, &blobs::blob_id(&raw)),
        };
        assert_eq!(raw_path(root, ACCT, MBOX, 7), Some(copied_from));
        assert_eq!(messages_dir(root, ACCT, MBOX), mailbox_dir(root, ACCT, MBOX).join("cur"));

        assert_eq!(find(root, ACCT, MBOX, 8), None);
        assert_eq!(read_raw(root, ACCT, MBOX, 8).unwrap(), None);
        assert_eq!(raw_path(root, ACCT, MBOX, 8), None);

        // A second write of the uid under other flags replaces the first copy.
        let again = write_replacing(root, ACCT, MBOX, 7, b"new", &flags(&["seen"])).unwrap();
        assert_eq!(again.name, leaf(format, 7, "S"));
        assert_eq!(list(root, ACCT, MBOX).unwrap(), vec![again]);
        assert_eq!(read_raw(root, ACCT, MBOX, 7).unwrap(), Some(b"new".to_vec()));
    }

    #[test]
    fn set_flags_renames_and_list_reports_new_flags() {
        run_both(set_flags_reports_new_flags);
    }

    fn set_flags_reports_new_flags(root: &Path, format: Format) {
        write(root, ACCT, MBOX, 3, b"three", &flags(&["seen"])).unwrap();
        write(root, ACCT, MBOX, 4, b"four", &[]).unwrap();

        let renamed = set_flags(root, ACCT, MBOX, 3, &flags(&["seen", "flagged"])).unwrap().expect("uid 3 is held");
        assert_eq!(renamed.name, leaf(format, 3, "FS"));
        assert_eq!(renamed.flags, flags(&["flagged", "seen", "\\Seen", "\\Flagged"]));
        assert!(!messages_dir(root, ACCT, MBOX).join(format!("3{INFO_PREFIX}S.eml")).exists(), "the old name is gone");

        let listed = list(root, ACCT, MBOX).unwrap();
        assert_eq!(listed.iter().map(|e| (e.uid, e.name.clone())).collect::<Vec<_>>(), vec![
            (3, leaf(format, 3, "FS")),
            (4, leaf(format, 4, "")),
        ]);
        assert_eq!(listed[0], renamed);
        assert_eq!(read_raw(root, ACCT, MBOX, 3).unwrap(), Some(b"three".to_vec()), "a flag change keeps the bytes");

        // The same flags again: nothing to rename, the same entry back.
        assert_eq!(set_flags(root, ACCT, MBOX, 3, &flags(&["flagged", "seen"])).unwrap(), Some(renamed));
        assert_eq!(set_flags(root, ACCT, MBOX, 9, &flags(&["seen"])).unwrap(), None, "a uid not held");
    }

    #[test]
    fn remove_deletes_and_find_is_none() {
        run_both(remove_deletes_every_copy);
    }

    fn remove_deletes_every_copy(root: &Path, _format: Format) {
        let dir = messages_dir(root, ACCT, MBOX);
        write(root, ACCT, MBOX, 5, b"five", &flags(&["seen"])).unwrap();
        // A crash-left second copy of uid 5 under other flags (in a JMAP
        // vault, a Maildir copy beside its record), and its decrypted copy.
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("5{INFO_PREFIX}.eml")), b"five").unwrap();
        crate::pgp::write_copy(&dir, 5, b"plain").unwrap();
        assert!(crate::pgp::copy_path(&dir, 5).exists());
        write(root, ACCT, MBOX, 6, b"six", &[]).unwrap();

        assert!(remove(root, ACCT, MBOX, 5).unwrap());
        assert_eq!(find(root, ACCT, MBOX, 5), None);
        assert!(!crate::pgp::copy_path(&dir, 5).exists(), "the decrypted copy goes with the original");
        assert_eq!(list(root, ACCT, MBOX).unwrap().iter().map(|e| e.uid).collect::<Vec<_>>(), vec![6]);
        assert!(!remove(root, ACCT, MBOX, 5).unwrap(), "nothing left to remove");
        assert!(find(root, ACCT, MBOX, 6).is_some(), "another uid is untouched");
    }

    #[test]
    fn list_of_missing_mailbox_is_empty_not_error() {
        run_both(missing_mailbox_is_empty);
    }

    fn missing_mailbox_is_empty(root: &Path, _format: Format) {
        assert_eq!(list(root, ACCT, "Nope").unwrap(), Vec::<Entry>::new());
        assert_eq!(uids(root, ACCT, "Nope").unwrap(), BTreeSet::new());
        assert_eq!(highest_uid(root, ACCT, "Nope").unwrap(), 0);
        assert_eq!(uid_message_ids(root, ACCT, "Nope").unwrap(), Vec::new());
        assert_eq!(find(root, ACCT, "Nope", 1), None);
        assert_eq!(read_raw(root, ACCT, "Nope", 1).unwrap(), None);
        assert_eq!(read_header_section(root, ACCT, "Nope", 1, 64).unwrap(), None);
        assert_eq!(set_flags(root, ACCT, "Nope", 1, &flags(&["seen"])).unwrap(), None);
        assert!(!remove(root, ACCT, "Nope", 1).unwrap());
        assert_eq!(raw_path(root, ACCT, "Nope", 1), None);

        // A message directory that exists but cannot be listed is an error, not empty.
        #[cfg(unix)]
        {
            let mbox = mailbox_dir(root, ACCT, "Broken");
            fs::create_dir_all(&mbox).unwrap();
            fs::write(mbox.join("cur"), b"not a directory").unwrap();
            assert!(list(root, ACCT, "Broken").is_err());
            assert!(uids(root, ACCT, "Broken").is_err());
        }
    }

    #[test]
    fn uids_and_highest_include_orphaned() {
        run_both(uids_include_orphaned);
    }

    fn uids_include_orphaned(root: &Path, _format: Format) {
        write(root, ACCT, MBOX, 3, b"Message-ID: <three@x.test>\r\n\r\nthree", &flags(&["seen"])).unwrap();
        write(root, ACCT, MBOX, 5, b"Subject: no id\r\n\r\nfive", &[]).unwrap();
        // Strays that name no uid: a write_atomic temp and a text file.
        let dir = messages_dir(root, ACCT, MBOX);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!(".8{INFO_PREFIX}S.eml.tmp-1-2")), b"temp").unwrap();
        fs::write(dir.join("notes.txt"), b"stray").unwrap();
        // orphaned/: a set-aside uid 9, and a second set-aside copy of 3 under a dedupe suffix.
        let orphaned = mailbox_dir(root, ACCT, MBOX).join(maildir::ORPHAN_DIR);
        fs::create_dir_all(&orphaned).unwrap();
        fs::write(orphaned.join(format!("9{INFO_PREFIX}S.eml")), b"Message-ID: <nine@x.test>\r\n\r\nnine").unwrap();
        fs::write(orphaned.join(format!("3{INFO_PREFIX}S.eml.1")), b"Message-ID: <old-three@x.test>\r\n\r\nold").unwrap();

        assert_eq!(uids(root, ACCT, MBOX).unwrap(), BTreeSet::from([3, 5, 9]));
        assert_eq!(highest_uid(root, ACCT, MBOX).unwrap(), 9);
        assert_eq!(uid_message_ids(root, ACCT, MBOX).unwrap(), vec![
            (3, Some("three@x.test".to_string())),
            (5, None),
            (3, Some("old-three@x.test".to_string())),
            (9, Some("nine@x.test".to_string())),
        ]);
        // `list` is the held messages only: no orphaned/, no strays.
        assert_eq!(list(root, ACCT, MBOX).unwrap().iter().map(|e| e.uid).collect::<Vec<_>>(), vec![3, 5]);
    }

    #[test]
    fn read_header_section_stops_at_blank_line_or_max() {
        run_both(header_section_stops_at_blank_line);
    }

    fn header_section_stops_at_blank_line(root: &Path, _format: Format) {
        write(root, ACCT, MBOX, 4, b"From: a@x\r\nSubject: hi\r\n\r\nbody text\r\n", &[]).unwrap();
        write(root, ACCT, MBOX, 5, b"A: 1\nB: 2\n\nbody", &[]).unwrap();

        assert_eq!(read_header_section(root, ACCT, MBOX, 4, 1024).unwrap(), Some(b"From: a@x\r\nSubject: hi\r\n".to_vec()));
        assert_eq!(read_header_section(root, ACCT, MBOX, 5, 1024).unwrap(), Some(b"A: 1\nB: 2\n".to_vec()));
        // No blank line within `max` bytes: all of them.
        assert_eq!(read_header_section(root, ACCT, MBOX, 4, 9).unwrap(), Some(b"From: a@x".to_vec()));
        assert_eq!(read_header_section(root, ACCT, MBOX, 6, 1024).unwrap(), None);
    }

    /// Only regular files named for a uid are copies: not a temp name, a
    /// non-canonical or legacy name, junk, a directory or a symlink. An
    /// import-range file is a vault copy like any other.
    #[test]
    fn held_uids_are_the_uid_files_and_nothing_else() {
        use crate::maildir::IMPORT_UID_BASE;
        let root = tempfile::tempdir().unwrap();
        let cur = messages_dir(root.path(), "acc", "INBOX");
        std::fs::create_dir_all(&cur).unwrap();
        let sep = INFO_PREFIX;
        for name in [
            format!("7{sep}S.eml"),
            format!("3{sep}AS.eml"),
            format!("{IMPORT_UID_BASE}{sep}A.eml"),
            format!(".9{sep}S.eml.tmp-1234"),
            format!("012{sep}S.eml"),
            "12.eml".to_string(),
            "notes.txt".to_string(),
        ] {
            std::fs::write(cur.join(name), b"x").unwrap();
        }
        std::fs::create_dir(cur.join(format!("5{sep}S.eml"))).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(cur.join(format!("7{sep}S.eml")), cur.join(format!("8{sep}S.eml"))).unwrap();

        assert_eq!(held_uids(root.path(), "acc", "INBOX"), Some(vec![3, 7, IMPORT_UID_BASE]));
    }

    /// No message directory under a vault that is there: an empty folder.
    /// The vault gone: unknown, never empty.
    #[test]
    fn a_missing_folder_is_empty_and_a_missing_vault_is_unknown() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(held_uids(root.path(), "acc", "Never"), Some(Vec::new()));
        let gone = root.path().join("unplugged");
        assert_eq!(held_uids(&gone, "acc", "INBOX"), None);
    }

    #[test]
    fn mirror_cur_joins_the_raw_mailbox_name() {
        let mirror = Path::new("mirror-root");
        assert_eq!(
            maildir::mirror_cur(mirror, "me@x.test", "Work/Clients").unwrap(),
            mirror.join("me@x.test").join("Work/Clients").join("cur")
        );
    }

    #[test]
    fn mailbox_dir_level_reads_keep_what_derived_stores_need() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mbox = mailbox_dir_at(&root.join("Maildir"), ACCT, MBOX);
        assert_eq!(mbox, mailbox_dir(root, ACCT, MBOX));
        // No message directory yet: NotFound is kept, never an empty listing.
        assert_eq!(scan_dir(&mbox).unwrap_err().kind(), io::ErrorKind::NotFound);
        assert_eq!(count_files(&mbox).unwrap_err().kind(), io::ErrorKind::NotFound);
        assert_eq!(has_message_dir(&mbox).unwrap_err().kind(), io::ErrorKind::NotFound);

        write(root, ACCT, MBOX, 3, b"three", &flags(&["seen", "flagged"])).unwrap();
        write(root, ACCT, MBOX, 4, b"four", &[]).unwrap();
        let dir = messages_dir(root, ACCT, MBOX);
        fs::write(dir.join("notes.txt"), b"stray").unwrap();
        // A second name for uid 4 that is a directory: listed, never readable.
        let odd = format!("4{INFO_PREFIX}T.eml");
        fs::create_dir(dir.join(&odd)).unwrap();
        assert!(has_message_dir(&mbox).unwrap());
        assert_eq!(count_files(&mbox).unwrap(), 3, "every uid-named entry, the directory too");

        let scan = scan_dir(&mbox).unwrap();
        assert!(scan.unstatted.is_empty());
        assert_eq!(scan.entries.iter().map(|e| e.uid).collect::<Vec<_>>(), vec![3, 4], "one entry per uid");
        let three = find(root, ACCT, MBOX, 3).unwrap();
        assert_eq!((scan.entries[0].uid, &scan.entries[0].name, &scan.entries[0].flags), (3, &three.name, &three.flags));
        assert_eq!(scan.entries[0].size, 5);
        assert_eq!(find_at(&mbox, 3), Some(three));
        assert_eq!(find_at(&mbox, 9), None);

        assert_eq!(read_listed(&mbox, 3, &scan.entries[0].name).unwrap(), b"three".to_vec());
        assert_eq!(read_listed(&mbox, 3, &format!("3{INFO_PREFIX}.eml")).unwrap_err().kind(), io::ErrorKind::NotFound);
        let dir_err = read_listed(&mbox, 4, &odd).unwrap_err().kind();
        assert!(matches!(dir_err, io::ErrorKind::IsADirectory | io::ErrorKind::NotADirectory), "{dir_err:?}");

        // The flags of a stored name, and the letters the index keeps for them.
        let name = format!("7{INFO_PREFIX}FS.eml");
        assert_eq!(flags_in_name(&name), flags(&["flagged", "seen", "\\Seen", "\\Flagged"]));
        assert_eq!(flag_letters(&flags_in_name(&name)), "FS");
        assert_eq!(flag_letters(&flags(&["Seen", "a", "\\Answered", "replied"])), "SAR", "in order, case-blind, letters too");
        assert_eq!(entry_name(7, &flags(&["seen", "flagged"])), name);
        assert_eq!(flag_letters(&flags_in_name(&entry_name(7, &flags(&["replied", "draft"])))), "DR");
    }

    #[test]
    fn uid_space_raw_paths_and_list_at_a_mailbox_dir() {
        use crate::maildir::IMPORT_UID_BASE;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mbox = mailbox_dir(root, ACCT, MBOX);
        // Nothing on disk yet: an empty space, an empty map, an empty listing.
        let empty = uid_space_at(&mbox).unwrap();
        assert!(empty.taken.is_empty() && empty.held.is_empty());
        assert!(raw_paths_at(&mbox).is_empty());
        assert_eq!(list_at(&mbox).unwrap(), Vec::new());

        write(root, ACCT, MBOX, 3, b"Message-ID: <three@x.test>\r\n\r\nthree", &flags(&["seen"])).unwrap();
        write(root, ACCT, MBOX, IMPORT_UID_BASE + 2, b"imported", &[]).unwrap();
        let dir = messages_dir(root, ACCT, MBOX);
        assert_eq!(maildir_messages_dir(&mbox), dir);
        // A legacy name: taken by the loose rule, never held.
        fs::write(dir.join("12.eml"), b"legacy").unwrap();
        let orphaned = mbox.join(maildir::ORPHAN_DIR);
        fs::create_dir_all(&orphaned).unwrap();
        fs::write(orphaned.join(format!("20{INFO_PREFIX}S.eml")), b"set aside").unwrap();

        let space = uid_space_at(&mbox).unwrap();
        assert_eq!(space.taken, uids(root, ACCT, MBOX).unwrap());
        assert_eq!(space.taken, BTreeSet::from([3, 12, 20, IMPORT_UID_BASE + 2]));
        let held: BTreeSet<u32> = space.held.keys().copied().collect();
        assert_eq!(held, BTreeSet::from([3, IMPORT_UID_BASE + 2]));
        assert_eq!(space.held.get(&3), raw_path(root, ACCT, MBOX, 3).as_ref());
        let paths = raw_paths_at(&mbox);
        assert_eq!(paths.get(&3), raw_path(root, ACCT, MBOX, 3).as_ref());
        assert_eq!(paths.len(), 2, "held copies only: {paths:?}");
        assert_eq!(list_at(&mbox).unwrap(), list(root, ACCT, MBOX).unwrap());

        // The import range: past its highest uid, its first uid when empty, None when full.
        assert_eq!(next_import_uid(space.taken.iter().copied()), Some(IMPORT_UID_BASE + 3));
        assert_eq!(next_import_uid([3, 12]), Some(IMPORT_UID_BASE));
        assert_eq!(next_import_uid([u32::MAX]), None);

        // A message directory that will not list is an error that names it.
        #[cfg(unix)]
        {
            let broken = mailbox_dir(root, ACCT, "Broken");
            fs::create_dir_all(&broken).unwrap();
            fs::write(broken.join("cur"), b"not a directory").unwrap();
            let err = uid_space_at(&broken).unwrap_err();
            assert!(err.to_string().starts_with("could not list "), "{err}");
            assert!(raw_paths_at(&broken).is_empty(), "lenient: an unlistable directory is empty");
        }
    }

    #[test]
    fn decrypted_copy_round_trips_beside_the_message_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let original = b"Subject: sealed\r\n\r\n-----BEGIN PGP MESSAGE-----\r\n".to_vec();
        assert_eq!(read_decrypted_copy(root, ACCT, MBOX, 7, &original), None, "no copy yet");

        let copy = format!("X-MailVault-Source: {}\r\nSubject: sealed\r\n\r\nplain", crate::pgp::source_tag(&original));
        write_decrypted_copy(root, ACCT, MBOX, 7, copy.as_bytes()).unwrap();
        // Where `pgp` and every vault reader look for it.
        let dir = messages_dir(root, ACCT, MBOX);
        assert_eq!(fs::read(crate::pgp::copy_path(&dir, 7)).unwrap(), copy.as_bytes());
        assert_eq!(read_decrypted_copy(root, ACCT, MBOX, 7, b"other bytes"), None, "made from other bytes");
        assert_eq!(read_decrypted_copy(root, ACCT, MBOX, 7, &original), Some(copy.into_bytes()));
        // Never a message: neither the listing nor the uid space sees it.
        assert_eq!(list(root, ACCT, MBOX).unwrap(), Vec::new());
        assert!(uids(root, ACCT, MBOX).unwrap().is_empty());
    }

    #[test]
    fn archive_side_reads_and_writes_keep_their_maildir_rules() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = messages_dir(root, ACCT, MBOX);
        assert!(archived_paths(root, ACCT, MBOX).is_empty(), "no folder yet");
        assert_eq!(archived_name(root, ACCT, MBOX, 3), None);
        create_messages_dir(root, ACCT, MBOX).unwrap();
        assert!(dir.is_dir());

        // A working-cache copy of 3, then an archived one beside it: write_new removes nothing.
        let three = b"Message-ID: <three@x.test>\r\n\r\nthree".to_vec();
        let cache = write_new(root, ACCT, MBOX, 3, &three, &flags(&["seen"]), false).unwrap();
        let archived = write_new(root, ACCT, MBOX, 3, &three, &flags(&["archived", "seen"]), true).unwrap();
        assert_eq!(cache, dir.join(format!("3{INFO_PREFIX}S.eml")));
        assert_eq!(archived, entry_path(root, ACCT, MBOX, &format!("3{INFO_PREFIX}AS.eml")));
        assert!(cache.exists() && archived.exists());
        assert_eq!(fs::read(&archived).unwrap(), three);
        assert_eq!(maildir::mirror_filename(3, &flags(&["archived", "seen"])), format!("3{INFO_PREFIX}AS.eml"));
        assert_eq!(archived_paths(root, ACCT, MBOX), HashMap::from([(3, archived.clone())]), "the archived copy wins");
        assert_eq!(archived_name(root, ACCT, MBOX, 3), Some(format!("3{INFO_PREFIX}AS.eml")));
        assert_eq!(archived_name(root, ACCT, MBOX, 4), None);

        // 3 is archived with the expected id, 4 is not held, 5 holds another message.
        write_new(root, ACCT, MBOX, 5, b"Message-ID: <other@x.test>\r\n\r\nfive", &flags(&["archived"]), true).unwrap();
        let expected = HashMap::from([(3, "<three@x.test>".to_string()), (5, "<five@x.test>".to_string())]);
        assert_eq!(verify_archived(root, ACCT, MBOX, &[3, 4, 5], Some(&expected)), (vec![3], vec![4], vec![5]));
        let listing = archived_paths(root, ACCT, MBOX);
        assert_eq!(verify_archived_strict(root, ACCT, MBOX, &listing, &[3, 4, 5], &expected), (vec![3], vec![4], vec![5]));

        // A listed path renamed since resolves by uid once more.
        let renamed = set_flags(root, ACCT, MBOX, 5, &flags(&["archived", "seen"])).unwrap().unwrap();
        let renamed_path = entry_path(root, ACCT, MBOX, &renamed.name);
        assert_eq!(raw_path_listed(root, ACCT, MBOX, 5, &listing[&5]), Some(renamed_path.clone()));
        assert_eq!(raw_path_listed(root, ACCT, MBOX, 5, &renamed_path), Some(renamed_path.clone()));
        remove_listed(root, ACCT, MBOX, 5, &listing[&5]);
        assert_eq!(find(root, ACCT, MBOX, 5), None, "the renamed copy is the one removed");
        assert_eq!(raw_path_listed(root, ACCT, MBOX, 5, &listing[&5]), None);
        remove_listed(root, ACCT, MBOX, 5, &listing[&5]);

        // An undone delete re-filed under its new uid keeps its flags.
        assert_eq!(rebind_uids(root, ACCT, MBOX, &[(3, 12), (8, 13)]).len(), 1);
        assert!(find(root, ACCT, MBOX, 12).is_some());
    }

    #[test]
    fn mirror_uid_listing_keeps_legacy_names_without_jmap_siblings() {
        let temp = tempfile::tempdir().unwrap();
        let cur = temp.path().join("cur");
        fs::create_dir(&cur).unwrap();
        for name in [format!("1{INFO_PREFIX}S.eml"), "2.eml".to_string(), "3_S.eml".to_string(), "3.eml".to_string(), "notes.txt".to_string()] {
            fs::write(cur.join(name), b"mail").unwrap();
        }
        fs::create_dir(cur.join("4.eml")).unwrap();
        let records = temp.path().join("jmap");
        fs::create_dir(&records).unwrap();
        fs::write(records.join("99.json"), b"{}").unwrap();

        assert_eq!(mirror_uids_in(&cur).unwrap(), HashSet::from([1, 2, 3, 4]));
    }

    #[test]
    fn mirror_uid_listing_reports_missing_or_unlistable_directories() {
        let temp = tempfile::tempdir().unwrap();
        let cur = temp.path().join("cur");
        assert_eq!(mirror_uids_in(&cur).unwrap_err().kind(), io::ErrorKind::NotFound);
        fs::write(&cur, b"not a directory").unwrap();
        assert!(mirror_uids_in(&cur).is_err());
    }

    #[test]
    fn backup_and_flag_passes_keep_their_maildir_rules() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mbox = mailbox_dir(root, ACCT, MBOX);
        let dir = maildir_messages_dir(&mbox);
        assert_eq!(loose_uids_in(&dir).unwrap(), HashSet::new(), "a folder not there holds none");
        assert!(mirror_sources_in(&dir).is_empty() && raw_paths_in(&dir).is_empty() && flag_paths(root, ACCT, MBOX).is_empty());

        // 3: a cache copy beside an archived one; 7: one copy; 12: a legacy name; 15: a directory; a stray.
        create_messages_dir(root, ACCT, MBOX).unwrap();
        write_new(root, ACCT, MBOX, 3, b"three", &flags(&["seen"]), true).unwrap();
        let archived = write_new(root, ACCT, MBOX, 3, b"three", &flags(&["archived"]), true).unwrap();
        let seven = write_new(root, ACCT, MBOX, 7, b"seven", &flags(&["seen"]), true).unwrap();
        fs::write(dir.join("12.eml"), b"legacy").unwrap();
        fs::create_dir(dir.join("15.eml")).unwrap();
        fs::write(dir.join("notes.txt"), b"stray").unwrap();

        assert_eq!(loose_uids_in(&dir).unwrap(), HashSet::from([3, 7, 12, 15]), "the loose rule, a directory too");
        let sources: HashSet<(u32, String)> = mirror_sources_in(&dir)
            .into_iter()
            .map(|(uid, name, path)| {
                assert_eq!(path, dir.join(&name));
                (uid, name)
            })
            .collect();
        assert_eq!(
            sources,
            HashSet::from([
                (3, format!("3{INFO_PREFIX}S.eml")),
                (3, format!("3{INFO_PREFIX}A.eml")),
                (7, format!("7{INFO_PREFIX}S.eml")),
                (12, "12.eml".to_string()),
            ]),
            "every file with a uid, no directory"
        );
        assert_eq!(raw_paths_in(&dir), raw_paths_at(&mbox));
        assert_eq!(raw_paths_in(&dir).len(), 2, "the strict rule holds 3 and 7 only");
        let wanted = HashSet::from([3, 7, 9]);
        assert_eq!(archived_first_paths(root, ACCT, MBOX, &wanted), HashMap::from([(3, archived.clone()), (7, seven.clone())]), "the archived copy wins");
        let listed = flag_paths(root, ACCT, MBOX);
        assert_eq!(listed.get(&12), Some(&dir.join("12.eml")), "a legacy name is listed too");
        assert_eq!(listed.get(&7), Some(&seven));

        // Re-filed under flags made of the ones the name holds; the same flags again is no rename.
        let renamed = set_flags_at(&seven, 7, |current| {
            assert!(current.contains(&"seen".to_string()), "{current:?}");
            flags(&["seen", "flagged"])
        });
        assert_eq!(renamed.unwrap(), Some(format!("7{INFO_PREFIX}FS.eml")));
        let refiled = dir.join(format!("7{INFO_PREFIX}FS.eml"));
        assert!(refiled.exists() && !seven.exists());
        assert_eq!(set_flags_at(&refiled, 7, |current| current.to_vec()).unwrap(), None, "already named so");
        assert_eq!(set_flags_at(&dir.join("12.eml"), 12, |_| flags(&["seen"])).unwrap(), Some(format!("12{INFO_PREFIX}S.eml")));
        assert!(set_flags_at(&dir.join("99.eml"), 99, |_| flags(&["seen"])).is_err(), "a file gone is an error");

        // A restore copies a mirror file in under its uid and the flags its name holds.
        let src = root.join("mirror-copy.eml");
        fs::write(&src, b"restored").unwrap();
        copy_in(&dir, 20, &maildir::mirror_flags(&format!("20{INFO_PREFIX}S.eml")), &src).unwrap();
        assert_eq!(read_raw(root, ACCT, MBOX, 20).unwrap(), Some(b"restored".to_vec()));
        assert_eq!(find(root, ACCT, MBOX, 20).unwrap().name, format!("20{INFO_PREFIX}S.eml"));

        // The mirror's own listing: every entry with a uid, a directory too.
        let mirror = root.join("mirror");
        fs::create_dir_all(mirror.join("5.eml")).unwrap();
        fs::write(mirror.join(format!("4{INFO_PREFIX}S.eml")), b"m").unwrap();
        fs::write(mirror.join("junk"), b"j").unwrap();
        let mut mirrored: Vec<u32> = maildir::mirror_files(&mirror).into_iter().map(|(uid, _, _)| uid).collect();
        mirrored.sort_unstable();
        assert_eq!(mirrored, vec![4, 5]);
        assert!(maildir::mirror_files(&root.join("gone")).is_empty());
    }

    #[test]
    fn import_export_and_restore_walks_keep_their_name_rules() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mbox = mailbox_dir(root, ACCT, MBOX);
        // Nothing on disk yet: every walk is empty.
        assert_eq!(named_uids_at(&mbox).count(), 0);
        assert_eq!(named_files_at(&mbox).count(), 0);
        assert_eq!(info_files_at(&mbox).count(), 0);

        create_messages_dir_at(&mbox).unwrap();
        let dir = maildir_messages_dir(&mbox);
        // A message, a legacy name, a temp, a name with no uid, an underscore
        // name, a directory and a stray.
        let seven = write_named_at(&mbox, &entry_name(7, &flags(&["seen"])), b"seven").unwrap();
        assert_eq!(seven, entry_path_at(&mbox, &format!("7{INFO_PREFIX}S.eml")));
        assert_eq!(raw_path(root, ACCT, MBOX, 7), Some(seven.clone()));
        fs::write(dir.join("12.eml"), b"legacy").unwrap();
        fs::write(dir.join(format!(".8{INFO_PREFIX}S.eml.tmp-1-2")), b"temp").unwrap();
        fs::write(dir.join(format!("x{INFO_PREFIX}A.eml")), b"no uid").unwrap();
        fs::write(dir.join("13_S.eml"), b"underscore").unwrap();
        fs::create_dir(dir.join(format!("15{INFO_PREFIX}S.eml"))).unwrap();
        fs::write(dir.join("notes.txt"), b"stray").unwrap();

        let mut named: Vec<u32> = named_uids_at(&mbox).collect();
        named.sort_unstable();
        assert_eq!(named, vec![7, 12, 15], "digits before the first separator or dot, a directory too");
        let mut files: Vec<(u32, String)> = named_files_at(&mbox)
            .map(|(uid, name, path)| {
                assert_eq!(path, dir.join(&name));
                (uid, name)
            })
            .collect();
        files.sort();
        assert_eq!(files, vec![(7, format!("7{INFO_PREFIX}S.eml")), (12, "12.eml".to_string())], "regular files only");
        let mut infos: Vec<String> = info_files_at(&mbox)
            .map(|(name, path)| {
                assert_eq!(path, dir.join(&name));
                name
            })
            .collect();
        infos.sort();
        let mut want = vec![
            format!(".8{INFO_PREFIX}S.eml.tmp-1-2"),
            format!("15{INFO_PREFIX}S.eml"),
            format!("7{INFO_PREFIX}S.eml"),
            format!("x{INFO_PREFIX}A.eml"),
        ];
        want.sort();
        assert_eq!(infos, want, "every name with an info part, whatever else it is");

        assert_eq!(uid_in_name(&format!("7{INFO_PREFIX}S.eml")), Some(7));
        assert_eq!(uid_in_name(&format!("x{INFO_PREFIX}A.eml")), None);
        assert_eq!(uid_in_name("12.eml"), None);

        // A name as given lands as is.
        let odd = format!("9{INFO_PREFIX}SA.eml");
        assert_eq!(write_named_at(&mbox, &odd, b"nine").unwrap(), dir.join(&odd));
        assert_eq!(read_raw(root, ACCT, MBOX, 9).unwrap(), Some(b"nine".to_vec()));
        // A directory named as is: `mailbox_dir_at` keeps a `..` the store's own names never hold.
        let raw_named = mailbox_dir_at(&root.join("Maildir"), ACCT, "..");
        create_messages_dir_at(&raw_named).unwrap();
        assert_eq!(entry_path_at(&raw_named, "1.eml"), vault_files::account_dir(&root.join("Maildir"), ACCT).join("..").join("cur").join("1.eml"));
    }

    // ── Task 7: the JMAP format behind the seam ──────────────────────────────

    /// A vault in `format` (a temp dir whose marker names it).
    fn vault(format: Format) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        set_vault_format(tmp.path(), format).unwrap();
        tmp
    }

    fn eml(id: &str) -> Vec<u8> {
        format!("Message-ID: <{id}@x.test>\r\nSubject: {id}\r\n\r\nbody of {id}\r\n").into_bytes()
    }

    #[test]
    fn a_vault_with_no_format_row_is_maildir_and_set_vault_format_sticks() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert_eq!(vault_format(root), Format::Maildir, "no marker: Maildir");
        set_vault_format(root, Format::Jmap).unwrap();
        assert_eq!(vault_format(root), Format::Jmap, "the cache follows the write");
        assert_eq!(crate::vault_layout::read_marker_value(root, FORMAT_KEY).as_deref(), Some("jmap"));
        set_vault_format(root, Format::Maildir).unwrap();
        assert_eq!(vault_format(root), Format::Maildir);
        assert_eq!(crate::vault_layout::read_marker_value(root, FORMAT_KEY).as_deref(), Some("maildir"));
    }

    #[test]
    fn jmap_record_wins_over_cur_file_for_same_uid() {
        let tmp = vault(Format::Maildir);
        let root = tmp.path();
        write(root, ACCT, MBOX, 7, &eml("old"), &flags(&["seen"])).unwrap();
        set_vault_format(root, Format::Jmap).unwrap();
        let record = write(root, ACCT, MBOX, 7, &eml("new"), &flags(&["flagged"])).unwrap();
        assert_eq!(record.name, "7.json");

        let mbox = mailbox_dir(root, ACCT, MBOX);
        assert!(messages_in(&mbox).join(format!("7{INFO_PREFIX}S.eml")).exists(), "the Maildir copy is still there");
        assert_eq!(find(root, ACCT, MBOX, 7), Some(record.clone()));
        assert_eq!(find_at(&mbox, 7), Some(record.clone()));
        assert_eq!(read_raw(root, ACCT, MBOX, 7).unwrap(), Some(eml("new")));
        assert_eq!(read_header_section(root, ACCT, MBOX, 7, 1024).unwrap(), Some(b"Message-ID: <new@x.test>\r\nSubject: new\r\n".to_vec()));
        assert_eq!(list(root, ACCT, MBOX).unwrap(), vec![record.clone()]);
        assert_eq!(raw_path(root, ACCT, MBOX, 7), Some(blobs::blob_path(root, &blobs::blob_id(&eml("new")))));
        let scan = scan_dir(&mbox).unwrap();
        assert_eq!(scan.entries, vec![record.clone()]);
        assert!(scan.unstatted.is_empty());
        assert_eq!(read_listed(&mbox, 7, &record.name).unwrap(), eml("new"));
        assert_eq!(uids(root, ACCT, MBOX).unwrap(), BTreeSet::from([7]));
        assert_eq!(held_uids(root, ACCT, MBOX), Some(vec![7]));
        // Both copies count for the uid space and for the Message-ID dedupe.
        assert_eq!(uid_message_ids(root, ACCT, MBOX).unwrap(), vec![(7, Some("old@x.test".into())), (7, Some("new@x.test".into()))]);
        // The flags of the record win: set_flags rewrites it, the Maildir name stays.
        let reflagged = set_flags(root, ACCT, MBOX, 7, &flags(&["seen", "archived"])).unwrap().unwrap();
        assert_eq!(reflagged.flags, flags(&["archived", "seen", "\\Seen"]));
        assert!(messages_in(&mbox).join(format!("7{INFO_PREFIX}S.eml")).exists());
    }

    #[test]
    fn write_never_removes_other_format() {
        let tmp = vault(Format::Maildir);
        let root = tmp.path();
        write(root, ACCT, MBOX, 7, &eml("maildir"), &[]).unwrap();
        set_vault_format(root, Format::Jmap).unwrap();
        write(root, ACCT, MBOX, 7, &eml("jmap"), &[]).unwrap();
        let mbox = mailbox_dir(root, ACCT, MBOX);
        assert!(messages_in(&mbox).join(format!("7{INFO_PREFIX}.eml")).exists(), "cur/7 is kept");
        assert!(jmap_in(&mbox).join("7.json").exists(), "jmap/7.json is written");
        assert_eq!(read_raw(root, ACCT, MBOX, 7).unwrap(), Some(eml("jmap")));
        // And back: a Maildir write keeps the record.
        set_vault_format(root, Format::Maildir).unwrap();
        write(root, ACCT, MBOX, 7, &eml("maildir again"), &flags(&["seen"])).unwrap();
        assert!(jmap_in(&mbox).join("7.json").exists(), "the record is kept");
        assert_eq!(read_raw(root, ACCT, MBOX, 7).unwrap(), Some(eml("jmap")), "and still wins");
    }

    #[test]
    fn write_replacing_removes_old_only_after_verify() {
        let tmp = vault(Format::Maildir);
        let root = tmp.path();
        let mbox = mailbox_dir(root, ACCT, MBOX);
        let old = messages_in(&mbox).join(format!("7{INFO_PREFIX}S.eml"));
        write(root, ACCT, MBOX, 7, &eml("old"), &flags(&["seen"])).unwrap();
        set_vault_format(root, Format::Jmap).unwrap();

        FAIL_VERIFY.with(|fail| fail.set(true));
        let refused = write_replacing(root, ACCT, MBOX, 7, &eml("new"), &flags(&["seen"]));
        FAIL_VERIFY.with(|fail| fail.set(false));
        assert!(refused.is_err(), "{refused:?}");
        assert!(old.exists(), "cur/7 survives a copy that did not verify");
        assert!(!jmap_in(&mbox).join("7.json").exists(), "the unverified record is taken back");
        assert_eq!(read_raw(root, ACCT, MBOX, 7).unwrap(), Some(eml("old")));

        let entry = write_replacing(root, ACCT, MBOX, 7, &eml("new"), &flags(&["seen"])).unwrap();
        assert_eq!(entry.name, "7.json");
        assert!(!old.exists(), "verified: the Maildir copy goes");
        assert_eq!(list(root, ACCT, MBOX).unwrap(), vec![entry]);
        assert_eq!(read_raw(root, ACCT, MBOX, 7).unwrap(), Some(eml("new")));

        // The other way: a Maildir write_replacing drops the record, never its blob.
        set_vault_format(root, Format::Maildir).unwrap();
        let entry = write_replacing(root, ACCT, MBOX, 7, &eml("newer"), &flags(&["seen"])).unwrap();
        assert_eq!(entry.name, format!("7{INFO_PREFIX}S.eml"));
        assert!(!jmap_in(&mbox).join("7.json").exists());
        assert!(blobs::blob_path(root, &blobs::blob_id(&eml("new"))).exists(), "the blob is the sweep's to judge");
        assert_eq!(read_raw(root, ACCT, MBOX, 7).unwrap(), Some(eml("newer")));
    }

    #[test]
    fn remove_other_format_refuses_without_a_kept_copy() {
        let tmp = vault(Format::Maildir);
        let root = tmp.path();
        write(root, ACCT, MBOX, 7, &eml("seven"), &[]).unwrap();
        assert!(remove_other_format(root, ACCT, MBOX, 7, Format::Jmap).is_err(), "no record to keep: nothing goes");
        assert!(find(root, ACCT, MBOX, 7).is_some());
        assert_eq!(remove_other_format(root, ACCT, MBOX, 7, Format::Maildir), Ok(false), "no record to remove");
        set_vault_format(root, Format::Jmap).unwrap();
        write(root, ACCT, MBOX, 7, &eml("seven"), &[]).unwrap();
        assert_eq!(remove_other_format(root, ACCT, MBOX, 7, Format::Jmap), Ok(true));
        assert!(!messages_in(&mailbox_dir(root, ACCT, MBOX)).join(format!("7{INFO_PREFIX}.eml")).exists());
        assert_eq!(find(root, ACCT, MBOX, 7).unwrap().name, "7.json");
    }

    /// The conversion job removes a uid's Maildir copy only once the record's
    /// blob is there and hashes to its id: the record alone is not the message.
    #[test]
    fn remove_other_format_keeps_the_maildir_copy_unless_the_blob_verifies() {
        let tmp = vault(Format::Maildir);
        let root = tmp.path();
        let old = messages_in(&mailbox_dir(root, ACCT, MBOX)).join(format!("7{INFO_PREFIX}.eml"));
        write(root, ACCT, MBOX, 7, &eml("seven"), &[]).unwrap();
        set_vault_format(root, Format::Jmap).unwrap();
        write(root, ACCT, MBOX, 7, &eml("seven"), &[]).unwrap();
        let blob = blobs::blob_path(root, &blobs::blob_id(&eml("seven")));
        let good = fs::read(&blob).unwrap();

        fs::write(&blob, b"junk").unwrap();
        let corrupt = remove_other_format(root, ACCT, MBOX, 7, Format::Jmap);
        assert!(corrupt.is_err(), "a corrupt blob refuses: {corrupt:?}");
        assert!(old.exists(), "the Maildir copy survives a corrupt blob");

        fs::remove_file(&blob).unwrap();
        let missing = remove_other_format(root, ACCT, MBOX, 7, Format::Jmap);
        assert!(missing.is_err(), "a missing blob refuses: {missing:?}");
        assert!(old.exists(), "the Maildir copy survives a missing blob");

        fs::write(&blob, &good).unwrap();
        assert_eq!(remove_other_format(root, ACCT, MBOX, 7, Format::Jmap), Ok(true));
        assert!(!old.exists(), "verified: the Maildir copy goes");
        assert_eq!(read_raw(root, ACCT, MBOX, 7).unwrap(), Some(eml("seven")));
    }

    /// A marker that will not read (here: not a database) is a failed read,
    /// not an absent one: it is not cached, so the next call asks again and a
    /// JMAP vault does not turn mixed for the life of the process.
    #[test]
    fn a_marker_that_will_not_read_is_not_cached_as_maildir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let marker = root.join(crate::vault_layout::MARKER_FILE);
        fs::write(&marker, vec![b'x'; 4096]).unwrap();
        assert_eq!(vault_format(root), Format::Maildir, "a marker that will not read answers Maildir this once");

        fs::remove_file(&marker).unwrap();
        // Straight to the marker, not `set_vault_format`: that would fill the cache.
        crate::vault_layout::write_marker_value(root, FORMAT_KEY, "jmap").unwrap();
        assert_eq!(vault_format(root), Format::Jmap, "the failed read was not cached");
    }

    /// An absent row is an answer and is cached; a vault adopted or moved to
    /// the same root asks the cache to forget it (Task 10).
    #[test]
    fn an_absent_marker_is_cached_until_the_cache_is_invalidated() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert_eq!(vault_format(root), Format::Maildir);
        crate::vault_layout::write_marker_value(root, FORMAT_KEY, "jmap").unwrap();
        assert_eq!(vault_format(root), Format::Maildir, "absent was cached");
        invalidate_vault_format(root);
        assert_eq!(vault_format(root), Format::Jmap, "read again after the invalidate");
        invalidate_vault_format(root);
        invalidate_vault_format(&root.join("nowhere"));
        assert_eq!(vault_format(root), Format::Jmap);
    }

    #[test]
    fn mixed_mailbox_lists_union() {
        let tmp = vault(Format::Maildir);
        let root = tmp.path();
        write(root, ACCT, MBOX, 1, &eml("one"), &flags(&["seen"])).unwrap();
        set_vault_format(root, Format::Jmap).unwrap();
        write(root, ACCT, MBOX, 2, &eml("two"), &flags(&["flagged", "archived"])).unwrap();
        let listed = list(root, ACCT, MBOX).unwrap();
        assert_eq!(
            listed.iter().map(|e| (e.uid, e.name.clone(), e.flags.clone())).collect::<Vec<_>>(),
            vec![
                (1, format!("1{INFO_PREFIX}S.eml"), flags(&["seen", "\\Seen"])),
                (2, "2.json".to_string(), flags(&["archived", "flagged", "\\Flagged"])),
            ]
        );
        let mbox = mailbox_dir(root, ACCT, MBOX);
        assert_eq!(list_at(&mbox).unwrap(), listed);
        assert_eq!(scan_dir(&mbox).unwrap().entries, listed);
        assert_eq!(count_files(&mbox).unwrap(), 2);
        assert_eq!(held_uids(root, ACCT, MBOX), Some(vec![1, 2]));
    }

    #[test]
    fn highest_uid_counts_jmap_records() {
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        write(root, ACCT, MBOX, 40, &eml("forty"), &[]).unwrap();
        let orphaned = mailbox_dir(root, ACCT, MBOX).join(maildir::ORPHAN_DIR);
        fs::create_dir_all(&orphaned).unwrap();
        fs::write(orphaned.join(format!("12{INFO_PREFIX}S.eml")), eml("twelve")).unwrap();
        assert!(!messages_dir(root, ACCT, MBOX).exists(), "cur/ is empty: never made");
        assert_eq!(highest_uid(root, ACCT, MBOX).unwrap(), 40);
        assert_eq!(uids(root, ACCT, MBOX).unwrap(), BTreeSet::from([12, 40]));
    }

    /// Carry (Task 3a/3b): `held_uids`, `taken_files_at` and `uid_space_at` read `jmap/`.
    #[test]
    fn held_uids_and_the_uid_space_count_records() {
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        write(root, ACCT, MBOX, 3, &eml("three"), &[]).unwrap();
        let mbox = mailbox_dir(root, ACCT, MBOX);
        let records = jmap_in(&mbox);
        // Not records: a temp, a non-canonical name, a directory, a stray.
        fs::write(records.join(".9.json.tmp-1-2"), b"temp").unwrap();
        fs::write(records.join("09.json"), b"zero").unwrap();
        fs::create_dir(records.join("5.json")).unwrap();
        fs::write(records.join("notes.txt"), b"stray").unwrap();
        assert_eq!(held_uids(root, ACCT, MBOX), Some(vec![3]), "regular record files only");
        assert_eq!(uids(root, ACCT, MBOX).unwrap(), BTreeSet::from([3, 5]), "the uid space counts every record name");

        let space = uid_space_at(&mbox).unwrap();
        assert_eq!(space.taken, BTreeSet::from([3, 5]));
        assert_eq!(space.held.get(&3), Some(&records.join("3.json")));
        assert_eq!(message_id_at(&records.join("3.json")).as_deref(), Some("three@x.test"), "read from the blob");
        assert_eq!(uid_message_ids(root, ACCT, MBOX).unwrap(), vec![(3, Some("three@x.test".into())), (5, None)]);
    }

    /// The gates that decided "a mailbox" by `cur/` alone: a mailbox holding
    /// records only is a mailbox to every one of them.
    #[test]
    fn a_jmap_only_mailbox_is_a_mailbox_to_every_listing() {
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        let mbox = mailbox_dir(root, ACCT, MBOX);
        assert_eq!(has_message_dir(&mbox).unwrap_err().kind(), io::ErrorKind::NotFound, "neither directory: never held mail");
        assert_eq!(scan_dir(&mbox).unwrap_err().kind(), io::ErrorKind::NotFound);
        assert_eq!(count_files(&mbox).unwrap_err().kind(), io::ErrorKind::NotFound);

        write(root, ACCT, MBOX, 4, &eml("four"), &flags(&["seen"])).unwrap();
        assert!(!messages_in(&mbox).exists());
        assert!(has_message_dir(&mbox).unwrap());
        assert_eq!(count_files(&mbox).unwrap(), 1);
        let scan = scan_dir(&mbox).unwrap();
        assert_eq!(scan.entries.len(), 1);
        assert_eq!((scan.entries[0].uid, scan.entries[0].name.as_str(), scan.entries[0].size), (4, "4.json", eml("four").len() as u64));
        assert_eq!(scan.entries[0].flags, flags(&["seen", "\\Seen"]));

        // A Maildir directory that is a file is still an error when no records sit beside it.
        #[cfg(unix)]
        {
            let broken = mailbox_dir(root, ACCT, "Broken");
            fs::create_dir_all(&broken).unwrap();
            fs::write(broken.join("cur"), b"not a directory").unwrap();
            assert!(!has_message_dir(&broken).unwrap());
            assert!(scan_dir(&broken).is_err());
        }
    }

    /// Carry (Task 2, BINDING): a record's name holds no flags, so a reader that
    /// keeps names reads them off `flags_name` with the letters it kept.
    #[test]
    fn flags_name_reads_a_records_flags_off_its_letters() {
        let maildir_name = format!("7{INFO_PREFIX}FS.eml");
        assert_eq!(flags_name(&maildir_name, "A"), maildir_name, "a Maildir name answers for itself");
        assert_eq!(flags_name("7.json", "FS"), maildir_name);
        assert_eq!(listed_flags("7.json", "AS"), flags(&["archived", "seen", "\\Seen"]));
        assert_eq!(listed_flags("7.json", ""), Vec::<String>::new());
        assert_eq!(flags_in_name("7.json"), Vec::<String>::new(), "the record name itself holds none");
        // What the stores keep is what a listing gave.
        let tmp = vault(Format::Jmap);
        let entry = write(tmp.path(), ACCT, MBOX, 7, &eml("seven"), &flags(&["seen", "replied", "draft"])).unwrap();
        assert_eq!(listed_flags(&entry.name, &flag_letters(&entry.flags)), entry.flags);
    }

    /// Carry (Task 3c): the decrypted copy stays `.decrypted/<uid>.eml` in the
    /// mailbox directory for a record too, is read through it and removed with it.
    #[test]
    fn a_records_decrypted_copy_sits_where_a_maildir_copy_does() {
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        let original = b"Subject: sealed\r\n\r\n-----BEGIN PGP MESSAGE-----\r\n".to_vec();
        write(root, ACCT, MBOX, 7, &original, &[]).unwrap();
        let copy = format!("X-MailVault-Source: {}\r\nSubject: sealed\r\n\r\nplain", crate::pgp::source_tag(&original));
        write_decrypted_copy(root, ACCT, MBOX, 7, copy.as_bytes()).unwrap();
        let mbox = mailbox_dir(root, ACCT, MBOX);
        let at = mbox.join(crate::pgp::DECRYPTED_DIR).join("7.eml");
        assert_eq!(fs::read(&at).unwrap(), copy.as_bytes());
        assert_eq!(read_decrypted_copy(root, ACCT, MBOX, 7, &original), Some(copy.clone().into_bytes()));
        assert_eq!(read_listed(&mbox, 7, "7.json").unwrap(), copy.as_bytes(), "a listed record reads through its decrypted copy");
        assert!(remove(root, ACCT, MBOX, 7).unwrap());
        assert!(!at.exists(), "plaintext never outlives the record");
    }

    #[test]
    fn a_message_the_parser_refuses_is_still_stored() {
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        let raw = b" starts with a space\r\nSubject: x\r\n\r\nbody".to_vec();
        assert!(record::build(1, MBOX, &raw, &[], None, None).is_err(), "the record builder refuses these bytes");
        let entry = write(root, ACCT, MBOX, 1, &raw, &flags(&["seen"])).unwrap();
        assert_eq!((entry.name.as_str(), entry.size), ("1.json", raw.len() as u64));
        assert_eq!(read_raw(root, ACCT, MBOX, 1).unwrap(), Some(raw.clone()));
        let rec = read_record(&jmap_in(&mailbox_dir(root, ACCT, MBOX)).join("1.json")).unwrap();
        assert_eq!(rec.blob, blobs::blob_id(&raw));
        assert_eq!(rec.email["blobId"], blobs::blob_id(&raw));
        assert_eq!(rec.email["size"], raw.len() as u64);
        assert!(blobs::verify(root, &rec.blob).unwrap());
    }

    /// Review carry (Task 6): `blob_path` validates nothing, so a blob id only
    /// reaches it from a record `parse` accepted. A record naming a hostile id
    /// is not a record: nothing outside the blob store is ever read.
    #[test]
    fn a_record_naming_a_hostile_blob_id_is_never_read() {
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        let entry = write(root, ACCT, MBOX, 7, &eml("seven"), &[]).unwrap();
        let path = jmap_in(&mailbox_dir(root, ACCT, MBOX)).join(&entry.name);
        fs::write(root.join("secret.eml"), b"Subject: not a blob\r\n\r\nsecret").unwrap();
        let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        value["blob"] = Value::String("sha256-../../secret".into());
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();

        assert_eq!(read_raw(root, ACCT, MBOX, 7).unwrap(), None, "read as no record, never as a path");
        assert_eq!(raw_path(root, ACCT, MBOX, 7), None);
        assert_eq!(find(root, ACCT, MBOX, 7), None);
        assert!(list(root, ACCT, MBOX).unwrap().is_empty());
        assert_eq!(message_id_at(&path), None);
        assert_eq!(read_listed(&mailbox_dir(root, ACCT, MBOX), 7, "7.json").unwrap_err().kind(), io::ErrorKind::InvalidData);
        assert_eq!(read_at(root, &path).unwrap_err().kind(), io::ErrorKind::InvalidData);
    }

    /// Review carry (Task 6): `put` on an intact blob it cannot touch fails, and
    /// so does the write: no record names a blob whose mtime its write left old.
    #[cfg(unix)]
    #[test]
    fn a_blob_put_cannot_refresh_fails_the_write() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        write(root, ACCT, MBOX, 1, &eml("shared"), &[]).unwrap();
        let blob = blobs::blob_path(root, &blobs::blob_id(&eml("shared")));
        fs::set_permissions(&blob, fs::Permissions::from_mode(0o444)).unwrap();
        let result = write(root, ACCT, "Work", 2, &eml("shared"), &[]);
        fs::set_permissions(&blob, fs::Permissions::from_mode(0o644)).unwrap();
        if result.is_ok() {
            return; // running as root: permissions aren't enforced, nothing to prove
        }
        assert!(!jmap_in(&mailbox_dir(root, ACCT, "Work")).join("2.json").exists(), "no record without a fresh blob");
        assert_eq!(read_raw(root, ACCT, MBOX, 1).unwrap(), Some(eml("shared")), "the first record is untouched");
    }

    /// The crate helpers `vault_files` and the registry use on listed paths.
    #[test]
    fn listed_paths_resolve_in_both_formats() {
        let tmp = vault(Format::Maildir);
        let root = tmp.path();
        let mbox = mailbox_dir(root, ACCT, MBOX);
        let maildir_entry = write(root, ACCT, MBOX, 1, &eml("one"), &flags(&["seen"])).unwrap();
        set_vault_format(root, Format::Jmap).unwrap();
        let record_entry = write(root, ACCT, MBOX, 2, &eml("two"), &flags(&["flagged"])).unwrap();

        let one = listed_path(&mbox, &maildir_entry.name);
        let two = listed_path(&mbox, &record_entry.name);
        assert_eq!(one, messages_in(&mbox).join(&maildir_entry.name));
        assert_eq!(two, jmap_in(&mbox).join("2.json"));
        assert!(!is_record_path(&one) && is_record_path(&two));
        assert_eq!(held_path(&mbox, 1), Some(one.clone()));
        assert_eq!(held_path(&mbox, 2), Some(two.clone()));
        assert_eq!(held_path(&mbox, 3), None);
        assert_eq!(entry_at(&one, 1), Some(maildir_entry.clone()));
        assert_eq!(entry_at(&two, 2), Some(record_entry.clone()));
        assert_eq!(read_at(root, &one).unwrap(), (maildir_entry.name.clone(), eml("one")));
        assert_eq!(read_at(root, &two).unwrap(), (format!("2{INFO_PREFIX}F.eml"), eml("two")), "a record reads as its blob under its flags name");

        // A record re-flagged in place keeps its name and bytes.
        let (after, changed) = set_record_flags(&two, 2, &flags(&["flagged", "seen"])).unwrap();
        assert!(changed);
        assert_eq!(after.name, "2.json");
        assert_eq!(set_record_flags(&two, 2, &flags(&["flagged", "seen"])).unwrap(), (after, false), "nothing to write");

        // A delete of one copy takes the other format's copy of the uid with it.
        write(root, ACCT, MBOX, 1, &eml("one"), &[]).unwrap();
        unlink(&one, 1).unwrap();
        unlink_other_format(&one, 1).unwrap();
        assert_eq!(find(root, ACCT, MBOX, 1), None, "neither copy is left");
        assert!(blobs::blob_path(root, &blobs::blob_id(&eml("one"))).exists(), "never a blob");
    }

    // ── Task 7b: walkers, blob sweep, server ids ─────────────────────────────

    /// Sets `path`'s mtime `age` into the past.
    fn age(path: &Path, age: std::time::Duration) {
        let file = fs::File::options().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - age).unwrap();
    }

    const DAY: std::time::Duration = std::time::Duration::from_secs(24 * 3600);

    #[test]
    fn sweep_keeps_shared_blob_until_last_record_removed() {
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        write(root, ACCT, MBOX, 1, &eml("shared"), &[]).unwrap();
        write(root, ACCT, "Work", 7, &eml("shared"), &flags(&["seen"])).unwrap();
        let blob = blobs::blob_path(root, &blobs::blob_id(&eml("shared")));
        assert_eq!(fs::read_dir(blob.parent().unwrap()).unwrap().count(), 1, "one blob for both copies");

        assert!(remove(root, ACCT, MBOX, 1).unwrap());
        assert!(blob.exists(), "remove never deletes a blob");
        let kept = sweep_blobs(root, std::time::Duration::ZERO).unwrap();
        assert_eq!((kept.records, kept.blobs, kept.removed), (1, 1, 0));
        assert!(blob.exists(), "Work/7 still names it");

        assert!(remove(root, ACCT, "Work", 7).unwrap());
        let swept = sweep_blobs(root, std::time::Duration::ZERO).unwrap();
        assert_eq!((swept.records, swept.removed, swept.freed_bytes), (0, 1, eml("shared").len() as u64));
        assert!(!blob.exists());
    }

    #[test]
    fn sweep_respects_grace_period() {
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        // A vault with a mailbox tree but no record: `Maildir/` is there, so an empty mark is believable.
        fs::create_dir_all(root.join("Maildir")).unwrap();
        let id = blobs::put(root, b"Subject: never named\r\n\r\nx").unwrap();
        let swept = sweep_blobs(root, DAY).unwrap();
        assert_eq!((swept.blobs, swept.young, swept.removed), (1, 1, 0));
        assert!(blobs::blob_path(root, &id).exists(), "an unreferenced fresh blob is kept");
        age(&blobs::blob_path(root, &id), 2 * DAY);
        assert_eq!(sweep_blobs(root, DAY).unwrap().removed, 1);
        assert!(!blobs::blob_path(root, &id).exists());
        // Nothing at all to sweep: no Maildir, no blob store.
        assert_eq!(sweep_blobs(&root.join("empty"), DAY).unwrap(), SweepStats::default());
    }

    #[test]
    fn reused_old_blob_survives_sweep() {
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        write(root, ACCT, MBOX, 1, &eml("x"), &[]).unwrap();
        let blob = blobs::blob_path(root, &blobs::blob_id(&eml("x")));
        assert!(remove(root, ACCT, MBOX, 1).unwrap());
        age(&blob, 2 * DAY);
        // A new record of the same bytes: `put` makes the old blob young again.
        write(root, ACCT, MBOX, 2, &eml("x"), &[]).unwrap();
        let swept = sweep_blobs(root, DAY).unwrap();
        assert_eq!(swept.removed, 0);
        assert!(blob.exists());
        assert_eq!(read_raw(root, ACCT, MBOX, 2).unwrap(), Some(eml("x")));
        // Even unreferenced again, it is young: the grace period covers it.
        assert!(remove(root, ACCT, MBOX, 2).unwrap());
        assert_eq!(sweep_blobs(root, DAY).unwrap().young, 1);
    }

    /// A record that will not parse (cut short, not even UTF-8), or parses
    /// but names no blob, no longer stops the sweep: every blob id in its
    /// text is kept, the rest is swept as usual, and the record stays.
    #[test]
    fn sweep_keeps_every_blob_a_damaged_record_names() {
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        write(root, ACCT, MBOX, 1, &eml("one"), &[]).unwrap();
        let cut = blobs::put(root, b"Subject: cut\r\n\r\nx").unwrap();
        let odd = blobs::put(root, b"Subject: odd\r\n\r\nx").unwrap();
        let orphan = blobs::put(root, b"Subject: old\r\n\r\nx").unwrap();
        for id in [&cut, &odd, &orphan] {
            age(&blobs::blob_path(root, id), 2 * DAY);
        }
        let dir = jmap_in(&mailbox_dir(root, ACCT, MBOX));
        let mut damaged = format!("{{\"format\":\"mailvault-jmap/1\",\"uid\":2,\"blob\":\"{cut}\",\"size\":").into_bytes();
        damaged.extend_from_slice(&[0xff, 0xfe, b'1']);
        fs::write(dir.join("2.json"), &damaged).unwrap();
        fs::write(dir.join("3.json"), format!("{{\"blob\":7,\"was\":\"{odd}\"}}")).unwrap();

        let swept = sweep_blobs(root, DAY).unwrap();
        assert_eq!((swept.records, swept.damaged, swept.removed), (3, 2, 1), "{swept:?}");
        assert!(blobs::blob_path(root, &cut).exists() && blobs::blob_path(root, &odd).exists(), "every blob id a damaged record names is kept");
        assert!(!blobs::blob_path(root, &orphan).exists(), "the rest is swept");
        assert_eq!(fs::read(dir.join("2.json")).unwrap(), damaged, "the record stays as it was");
    }

    /// A record that will not read at all (here, no permission) still stops
    /// the sweep with nothing removed: its text cannot be looked at.
    #[cfg(unix)]
    #[test]
    fn sweep_stops_on_a_record_it_cannot_read() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        write(root, ACCT, MBOX, 1, &eml("one"), &[]).unwrap();
        let orphan = blobs::put(root, b"Subject: old\r\n\r\nx").unwrap();
        age(&blobs::blob_path(root, &orphan), 2 * DAY);
        let record = jmap_in(&mailbox_dir(root, ACCT, MBOX)).join("1.json");
        fs::set_permissions(&record, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read(&record).is_ok() {
            fs::set_permissions(&record, fs::Permissions::from_mode(0o644)).unwrap();
            return; // root: permissions do not apply
        }
        let result = sweep_blobs(root, DAY);
        fs::set_permissions(&record, fs::Permissions::from_mode(0o644)).unwrap();
        let err = result.unwrap_err();
        assert!(err.contains("1.json"), "{err}");
        assert!(blobs::blob_path(root, &orphan).exists(), "nothing is removed when the mark is unsure");
    }

    /// `holds_format` finds a message of a format (a Maildir file, a record
    /// that parses) and passes over a damaged record; `record_damaged_at`
    /// tells a damaged record from none and from a good one.
    #[test]
    fn holds_format_finds_a_message_of_the_format_and_passes_over_a_damaged_record() {
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        assert!(!holds_format(root, Format::Maildir).unwrap() && !holds_format(root, Format::Jmap).unwrap(), "an empty vault holds neither");
        write(root, ACCT, MBOX, 1, &eml("one"), &[]).unwrap();
        assert!(holds_format(root, Format::Jmap).unwrap());
        assert!(!holds_format(root, Format::Maildir).unwrap());
        let dir = mailbox_dir(root, ACCT, MBOX);
        assert!(!record_damaged_at(&dir, 1), "a record that parses");
        assert!(!record_damaged_at(&dir, 2), "no record");
        fs::write(jmap_in(&dir).join("1.json"), b"{ cut").unwrap();
        assert!(record_damaged_at(&dir, 1));
        assert!(!holds_format(root, Format::Jmap).unwrap(), "a damaged record is no message to convert");
        set_vault_format(root, Format::Maildir).unwrap();
        write(root, ACCT, "Work", 4, &eml("four"), &[]).unwrap();
        assert!(holds_format(root, Format::Maildir).unwrap());
    }

    /// The leftover hint is one marker row. Pruning the blob store takes its
    /// empty directories, and the store once empty; never a blob.
    #[test]
    fn the_leftover_row_round_trips_and_pruning_keeps_every_blob() {
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        assert!(!leftover(root));
        set_leftover(root, true).unwrap();
        assert!(leftover(root));
        set_leftover(root, false).unwrap();
        assert!(!leftover(root));

        assert!(!has_blob_store(root));
        let id = blobs::put(root, b"Subject: kept\r\n\r\nx").unwrap();
        // Not a hex shard name, so never the blob's own.
        let empty = root.join(blobs::BLOB_DIR).join("zz");
        fs::create_dir_all(&empty).unwrap();
        assert!(has_blob_store(root));
        prune_blob_store(root);
        assert!(blobs::blob_path(root, &id).exists(), "a blob is never removed");
        assert!(!empty.exists(), "an empty shard goes");
        fs::remove_file(blobs::blob_path(root, &id)).unwrap();
        prune_blob_store(root);
        assert!(!has_blob_store(root), "the store goes once empty");
    }

    #[test]
    fn set_server_ids_writes_the_record_and_is_a_noop_without_one() {
        let tmp = vault(Format::Maildir);
        let root = tmp.path();
        let ids = record::ServerIds { email_id: "M1".into(), blob_id: "G1".into(), thread_id: Some("T1".into()) };
        write(root, ACCT, MBOX, 3, &eml("maildir"), &[]).unwrap();
        set_server_ids(root, ACCT, MBOX, 3, ids.clone()).unwrap();
        assert_eq!(read_raw(root, ACCT, MBOX, 3).unwrap(), Some(eml("maildir")), "a Maildir copy is untouched");
        set_server_ids(root, ACCT, MBOX, 9, ids.clone()).unwrap();

        set_vault_format(root, Format::Jmap).unwrap();
        write(root, ACCT, MBOX, 4, &eml("jmap"), &flags(&["seen"])).unwrap();
        set_server_ids(root, ACCT, MBOX, 4, ids.clone()).unwrap();
        let path = jmap_in(&mailbox_dir(root, ACCT, MBOX)).join("4.json");
        let rec = read_record(&path).unwrap();
        assert_eq!(rec.server, Some(ids.clone()));
        assert_eq!((rec.email["id"].as_str(), rec.email["threadId"].as_str()), (Some("M1"), Some("T1")));
        assert_eq!(rec.blob, blobs::blob_id(&eml("jmap")), "the local blob id stays");
        // A later write of the uid keeps the server ids.
        write(root, ACCT, MBOX, 4, &eml("jmap"), &flags(&["seen", "flagged"])).unwrap();
        assert_eq!(read_record(&path).unwrap().server, Some(ids));
    }

    /// Plan A Task 14: server ids a prepared message carries land in the
    /// record's one commit, and win over an older record's; `set_server_ids`
    /// writes only a change and names the record it rewrote.
    #[test]
    fn server_ids_land_in_the_commit_and_set_server_ids_writes_only_a_change() {
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        let ids = |e: &str| record::ServerIds { email_id: e.into(), blob_id: format!("G{e}"), thread_id: Some(format!("T{e}")) };
        let path = jmap_in(&mailbox_dir(root, ACCT, MBOX)).join("5.json");

        let prepared = prepare(root, ACCT, MBOX, 5, eml("five"), &[], None, Format::Jmap).unwrap().with_server_ids(ids("M5"));
        assert_eq!(prepared.server_ids(), Some(&ids("M5")));
        commit(root, ACCT, MBOX, &prepared, &flags(&["seen"])).unwrap();
        let rec = read_record(&path).unwrap();
        assert_eq!(rec.server, Some(ids("M5")));
        assert_eq!((rec.email["id"].as_str(), rec.email["threadId"].as_str()), (Some("M5"), Some("TM5")));

        let fresh = prepare(root, ACCT, MBOX, 5, eml("five"), &[], None, Format::Jmap).unwrap().with_server_ids(ids("M6"));
        commit(root, ACCT, MBOX, &fresh, &[]).unwrap();
        assert_eq!(read_record(&path).unwrap().server, Some(ids("M6")), "the server's ids now win over the old record's");
        let plain = prepare(root, ACCT, MBOX, 5, eml("five"), &[], None, Format::Jmap).unwrap();
        assert_eq!(plain.server_ids(), None);
        commit(root, ACCT, MBOX, &plain, &[]).unwrap();
        assert_eq!(read_record(&path).unwrap().server, Some(ids("M6")), "a write without ids keeps the old record's");

        let before = fs::read(&path).unwrap();
        assert_eq!(set_server_ids(root, ACCT, MBOX, 5, ids("M6")).unwrap(), None, "unchanged ids write nothing");
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(set_server_ids(root, ACCT, MBOX, 5, ids("M7")).unwrap(), Some(path.clone()));
        assert_eq!(read_record(&path).unwrap().server, Some(ids("M7")));
        assert_eq!(set_server_ids(root, ACCT, MBOX, 9, ids("M9")).unwrap(), None, "no record: nothing to write");
    }

    /// Carries (Tasks 4a, 4b, 5): every whole-mailbox walk the archive,
    /// backup, import, export and restore callers use reads `jmap/`, handing
    /// out a blob (bytes) or a record (identity) and an `.eml`-shaped name.
    #[test]
    fn walkers_read_records_beside_maildir_files() {
        let tmp = vault(Format::Maildir);
        let root = tmp.path();
        write(root, ACCT, MBOX, 1, &eml("one"), &flags(&["seen"])).unwrap();
        write(root, ACCT, MBOX, 2, &eml("two-old"), &[]).unwrap();
        set_vault_format(root, Format::Jmap).unwrap();
        write(root, ACCT, MBOX, 2, &eml("two"), &flags(&["archived", "seen"])).unwrap();
        write(root, ACCT, MBOX, 3, &eml("three"), &flags(&["flagged"])).unwrap();
        let mbox = mailbox_dir(root, ACCT, MBOX);
        let dir = maildir_messages_dir(&mbox);
        let blob = |id: &str| blobs::blob_path(root, &blobs::blob_id(&eml(id)));
        let record = |uid: u32| jmap_in(&mbox).join(format!("{uid}.json"));
        let one = messages_in(&mbox).join(format!("1{INFO_PREFIX}S.eml"));

        let paths = raw_paths_at(&mbox);
        assert_eq!(paths, HashMap::from([(1, one.clone()), (2, blob("two")), (3, blob("three"))]), "a record wins with its blob");
        assert_eq!(raw_paths_in(&dir), paths);
        assert_eq!(maildir_paths_at(&mbox).len(), 2, "the Maildir files alone: 1 and the old 2");
        assert_eq!(loose_uids_in(&dir).unwrap(), HashSet::from([1, 2, 3]));
        let mut uids: Vec<u32> = named_uids_at(&mbox).collect();
        uids.sort_unstable();
        assert_eq!(uids, vec![1, 2, 2, 3]);

        let mut named: Vec<(u32, String, PathBuf)> = named_files_at(&mbox).collect();
        named.sort();
        assert_eq!(named, vec![
            (1, format!("1{INFO_PREFIX}S.eml"), one.clone()),
            (2, format!("2{INFO_PREFIX}AS.eml"), blob("two")),
            (3, format!("3{INFO_PREFIX}F.eml"), blob("three")),
        ]);
        let mut infos: Vec<(String, PathBuf)> = info_files_at(&mbox).collect();
        infos.sort();
        assert_eq!(infos, named.iter().map(|(_, name, path)| (name.clone(), path.clone())).collect::<Vec<_>>(), "export names stay .eml");
        let mut sources = mirror_sources_in(&dir);
        sources.sort();
        assert_eq!(sources, named, "the mirror gets .eml copies named by their flags");

        assert_eq!(archived_paths(root, ACCT, MBOX), HashMap::from([(2, record(2))]));
        assert_eq!(archived_name(root, ACCT, MBOX, 2), Some("2.json".to_string()));
        assert_eq!(archived_name(root, ACCT, MBOX, 3), None, "a record that is not archived");
        assert!(is_archived_entry(root, ACCT, MBOX, "2.json") && !is_archived_entry(root, ACCT, MBOX, "3.json"));
        assert!(!is_archived_entry(root, ACCT, MBOX, &format!("1{INFO_PREFIX}S.eml")));
        assert_eq!(archived_first_paths(root, ACCT, MBOX, &HashSet::from([1, 2, 9])), HashMap::from([(1, one.clone()), (2, record(2))]));
        let flagged = flag_paths(root, ACCT, MBOX);
        assert_eq!((flagged.get(&2), flagged.get(&3)), (Some(&record(2)), Some(&record(3))));

        assert_eq!(entry_path(root, ACCT, MBOX, "3.json"), record(3));
        assert_eq!(stored_name(root, 3, &flags(&["seen"])), "3.json");
        assert_eq!(copy_name(root, ACCT, MBOX, 3, &blob("three")), Some(maildir::mirror_filename(3, &flags(&["flagged"]))));
        assert_eq!(copy_name(root, ACCT, MBOX, 1, &one), Some(format!("1{INFO_PREFIX}S.eml")));
        assert_eq!(raw_path_listed(root, ACCT, MBOX, 3, &record(3)), Some(blob("three")));
        assert_eq!(raw_path_listed(root, ACCT, MBOX, 3, &blob("three")), Some(blob("three")));
        let gone = messages_in(&mbox).join(format!("3{INFO_PREFIX}F.eml"));
        assert_eq!(raw_path_listed(root, ACCT, MBOX, 3, &gone), Some(blob("three")), "a listed Maildir name gone: the record");
        assert_eq!(read_path(&record(3)).unwrap(), eml("three"));
        assert_eq!(listed_message(&record(3)), Some((3, blob("three"), format!("3{INFO_PREFIX}F.eml"))));
        assert_eq!(listed_message(&one), None);

        // A flag pass re-files a record in place.
        let renamed = set_flags_at(&record(3), 3, |current| {
            assert_eq!(current, flags(&["flagged", "\\Flagged"]));
            flags(&["flagged", "seen"])
        });
        assert_eq!(renamed.unwrap(), Some("3.json".to_string()));
        assert_eq!(set_flags_at(&record(3), 3, |current| current.to_vec()).unwrap(), None);

        // A listed record or blob removes the record, never the blob.
        remove_listed(root, ACCT, MBOX, 3, &blob("three"));
        assert!(!record(3).exists() && blob("three").exists());
        remove_listed(root, ACCT, MBOX, 2, &record(2));
        assert!(!record(2).exists() && blob("two").exists());
        assert_eq!(read_raw(root, ACCT, MBOX, 2).unwrap(), Some(eml("two-old")), "the Maildir copy shows again");
    }

    /// Carries (Tasks 4a, 4b, 5): the name-given and new-copy writers write a
    /// record in a JMAP vault, and a copy in from the mirror does too.
    #[test]
    fn write_new_write_named_at_and_copy_in_write_records_in_a_jmap_vault() {
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        let mbox = mailbox_dir(root, ACCT, MBOX);
        create_messages_dir(root, ACCT, MBOX).unwrap();
        let written = write_new(root, ACCT, MBOX, 5, &eml("five"), &flags(&["archived"]), false).unwrap();
        assert_eq!(written, jmap_in(&mbox).join("5.json"));
        assert_eq!(read_raw(root, ACCT, MBOX, 5).unwrap(), Some(eml("five")));

        let name = format!("6{INFO_PREFIX}AS.eml");
        assert_eq!(entry_path_at(&mbox, &name), jmap_in(&mbox).join("6.json"), "where the write lands, for the caller's exists check");
        assert!(!entry_path_at(&mbox, &name).exists());
        assert_eq!(write_named_at(&mbox, &name, &eml("six")).unwrap(), jmap_in(&mbox).join("6.json"));
        assert_eq!(find(root, ACCT, MBOX, 6).unwrap().flags, flags(&["archived", "seen", "\\Seen"]));
        assert!(entry_path_at(&mbox, &name).exists(), "a second import of the name skips");
        // A name with no uid has no record form: it lands as named.
        assert_eq!(write_named_at(&mbox, "notes.txt", b"x").unwrap(), messages_in(&mbox).join("notes.txt"));

        let src = root.join("mirror-copy.eml");
        fs::write(&src, eml("seven")).unwrap();
        let dir = maildir_messages_dir(&mbox);
        assert_eq!(copy_in(&dir, 7, &flags(&["seen", "archived"]), &src).unwrap(), eml("seven").len() as u64);
        assert_eq!(find(root, ACCT, MBOX, 7).unwrap().name, "7.json");
        assert!(!messages_in(&mbox).join(format!("7{INFO_PREFIX}AS.eml")).exists());
    }

    #[test]
    fn verify_archived_reads_records() {
        let tmp = vault(Format::Maildir);
        let root = tmp.path();
        write(root, ACCT, MBOX, 1, &eml("one"), &flags(&["archived"])).unwrap();
        set_vault_format(root, Format::Jmap).unwrap();
        write(root, ACCT, MBOX, 2, &eml("two"), &flags(&["archived"])).unwrap();
        write(root, ACCT, MBOX, 3, &eml("three"), &flags(&["archived"])).unwrap();
        write(root, ACCT, MBOX, 4, &eml("four"), &[]).unwrap();
        let expected = HashMap::from([
            (1, "<one@x.test>".to_string()),
            (2, "<two@x.test>".to_string()),
            (3, "<other@x.test>".to_string()),
            (4, "<four@x.test>".to_string()),
        ]);
        let uids = [1, 2, 3, 4, 5];
        assert_eq!(verify_archived(root, ACCT, MBOX, &uids, Some(&expected)), (vec![1, 2], vec![4, 5], vec![3]));
        let listing = archived_paths(root, ACCT, MBOX);
        assert_eq!(verify_archived_strict(root, ACCT, MBOX, &listing, &uids, &expected), (vec![1, 2], vec![4, 5], vec![3]));
        // A record no longer archived since the listing is not proof.
        set_flags(root, ACCT, MBOX, 2, &[]).unwrap();
        assert_eq!(verify_archived_strict(root, ACCT, MBOX, &listing, &[2], &expected), (vec![], vec![2], vec![]));
    }

    #[test]
    fn rebind_uids_rekeys_records() {
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        write(root, ACCT, MBOX, 3, &eml("three"), &flags(&["archived"])).unwrap();
        write(root, ACCT, MBOX, 4, &eml("four"), &[]).unwrap();
        write(root, ACCT, MBOX, 13, &eml("taken"), &[]).unwrap();
        let rebound = rebind_uids(root, ACCT, MBOX, &[(3, 12), (4, 13), (8, 14)]);
        assert_eq!(rebound, vec![(3, 12)], "13 is taken, 8 holds nothing");
        assert_eq!(find(root, ACCT, MBOX, 3), None);
        let moved = find(root, ACCT, MBOX, 12).unwrap();
        assert_eq!((moved.name.as_str(), moved.flags.clone()), ("12.json", flags(&["archived"])));
        let rec = read_record(&jmap_in(&mailbox_dir(root, ACCT, MBOX)).join("12.json")).unwrap();
        assert_eq!(rec.uid, 12);
        assert!(rec.email["id"].as_str().unwrap().starts_with("L12-"));
        assert_eq!(read_raw(root, ACCT, MBOX, 12).unwrap(), Some(eml("three")));
    }

    #[test]
    fn demote_records_turns_records_into_verified_files() {
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        write(root, ACCT, MBOX, 3, &eml("three"), &flags(&["archived", "seen"])).unwrap();
        let mbox = mailbox_dir(root, ACCT, MBOX);
        fs::create_dir_all(messages_in(&mbox)).unwrap();
        fs::write(messages_in(&mbox).join(format!("3{INFO_PREFIX}.eml")), eml("stale")).unwrap();
        assert_eq!(demote_records(&mbox).unwrap(), 1);
        let entry = find(root, ACCT, MBOX, 3).unwrap();
        assert_eq!(entry.name, format!("3{INFO_PREFIX}AS.eml"));
        assert_eq!(read_raw(root, ACCT, MBOX, 3).unwrap(), Some(eml("three")), "the record's copy, not the stale file");
        assert!(!jmap_in(&mbox).join("3.json").exists());
        assert!(blobs::blob_path(root, &blobs::blob_id(&eml("three"))).exists(), "never a blob");
        assert_eq!(demote_records(&mbox).unwrap(), 0);
    }

    // ── Task 7b fix round 1 ──────────────────────────────────────────────────

    /// I1: an archived record whose blob is gone, or does not hash to its id,
    /// is not an archived copy: no Message-ID to compare is no excuse.
    #[test]
    fn a_record_without_its_blob_never_verifies() {
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        write(root, ACCT, MBOX, 1, &eml("one"), &flags(&["archived"])).unwrap();
        write(root, ACCT, MBOX, 2, &eml("two"), &flags(&["archived"])).unwrap();
        write(root, ACCT, MBOX, 3, &eml("three"), &flags(&["archived"])).unwrap();
        let listing = archived_paths(root, ACCT, MBOX);
        let none = HashMap::new();
        let ids = HashMap::from([(1, "<one@x.test>".to_string()), (2, "<two@x.test>".to_string()), (3, "<three@x.test>".to_string())]);
        let uids = [1, 2, 3];
        assert_eq!(verify_archived_strict(root, ACCT, MBOX, &listing, &uids, &ids), (vec![1, 2, 3], vec![], vec![]), "intact blobs verify");

        fs::remove_file(blobs::blob_path(root, &blobs::blob_id(&eml("one")))).unwrap();
        fs::write(blobs::blob_path(root, &blobs::blob_id(&eml("two"))), b"truncated").unwrap();
        for expected in [Some(&ids), Some(&none), None] {
            assert_eq!(verify_archived(root, ACCT, MBOX, &[1, 2], expected), (vec![], vec![1, 2], vec![]), "{expected:?}");
        }
        assert_eq!(verify_archived_strict(root, ACCT, MBOX, &listing, &[1, 2], &ids), (vec![], vec![1, 2], vec![]));
        assert_eq!(verify_archived_strict(root, ACCT, MBOX, &listing, &[1, 2], &none), (vec![], vec![1, 2], vec![]), "no expected id either");
        assert_eq!(verify_archived_strict(root, ACCT, MBOX, &listing, &uids, &ids), (vec![3], vec![1, 2], vec![]));
    }

    /// I2: a mailbox that vanished between the account listing and its
    /// `jmap/` read is not "no records".
    #[test]
    fn marking_a_vanished_mailbox_is_an_error_not_an_empty_mark() {
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        write(root, ACCT, MBOX, 1, &eml("one"), &[]).unwrap();
        let mut marked = HashSet::new();
        let mut stats = SweepStats::default();
        let gone = mailbox_dir(root, ACCT, "Renamed");
        assert!(mark_mailbox(&gone, &mut marked, &mut stats).is_err(), "the mailbox directory is gone");
        // A mailbox that exists and has no records yet is fine.
        let bare = mailbox_dir(root, ACCT, "Bare");
        fs::create_dir_all(&bare).unwrap();
        assert!(mark_mailbox(&bare, &mut marked, &mut stats).is_ok());
        assert!(marked.is_empty() && stats.records == 0);
    }

    /// I2: a vault with a blob store and no `Maildir/` (a half-mounted
    /// volume) aborts: every blob would look unreferenced.
    #[test]
    fn sweep_aborts_when_maildir_is_missing_but_blobs_exist() {
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        write(root, ACCT, MBOX, 1, &eml("one"), &[]).unwrap();
        let blob = blobs::blob_path(root, &blobs::blob_id(&eml("one")));
        age(&blob, 2 * DAY);
        fs::remove_dir_all(root.join("Maildir")).unwrap();
        let err = sweep_blobs(root, DAY).unwrap_err();
        assert!(err.contains("Maildir"), "{err}");
        assert!(blob.exists(), "nothing is removed");
    }

    /// I2: an account directory whose entries cannot be stated is an error,
    /// not a directory to skip.
    #[cfg(unix)]
    #[test]
    fn sweep_aborts_on_a_directory_it_cannot_state() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        write(root, ACCT, MBOX, 1, &eml("one"), &[]).unwrap();
        let blob = blobs::blob_path(root, &blobs::blob_id(&eml("one")));
        age(&blob, 2 * DAY);
        let maildir = root.join("Maildir");
        // Readable but not searchable: the listing works, a stat of an entry fails.
        fs::set_permissions(&maildir, fs::Permissions::from_mode(0o400)).unwrap();
        if fs::metadata(maildir.join(ACCT)).is_ok() {
            fs::set_permissions(&maildir, fs::Permissions::from_mode(0o700)).unwrap();
            return; // privileged: permissions do not apply
        }
        let result = sweep_blobs(root, DAY);
        fs::set_permissions(&maildir, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err(), "{result:?}");
        assert!(blob.exists(), "nothing is removed");
    }

    /// I3: a rebound record names its blob under a new name a running sweep
    /// has not listed, so the blob is made young first.
    #[test]
    fn rebind_uids_refreshes_the_blob_before_naming_it() {
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        write(root, ACCT, MBOX, 3, &eml("three"), &flags(&["archived"])).unwrap();
        let blob = blobs::blob_path(root, &blobs::blob_id(&eml("three")));
        age(&blob, 2 * DAY);
        assert_eq!(rebind_uids(root, ACCT, MBOX, &[(3, 12)]), vec![(3, 12)]);
        let since = SystemTime::now().duration_since(fs::metadata(&blob).unwrap().modified().unwrap()).unwrap_or_default();
        assert!(since < DAY, "the blob is young again: {since:?}");
        // A sweep keeps it.
        assert_eq!(sweep_blobs(root, DAY).unwrap().removed, 0);
    }

    // ── Task 9: prepare and commit, the conversion's reads ───────────────────

    /// The heavy half runs ahead: `prepare` stores the blob and builds the
    /// record but writes no record; `commit` writes it under the flags of the
    /// moment and keeps an existing record's server ids and `receivedAt`.
    #[test]
    fn prepare_stores_the_blob_and_commit_writes_the_record() {
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        let raw = eml("seven");
        let prepared = prepare(root, ACCT, MBOX, 7, raw.clone(), &flags(&["seen"]), Some("2026-10-01T10:00:00Z"), Format::Jmap).unwrap();
        assert_eq!((prepared.uid(), prepared.format(), prepared.raw(), prepared.root()), (7, Format::Jmap, raw.as_slice(), root));
        assert!(blobs::verify(root, &blobs::blob_id(&raw)).unwrap(), "the blob is stored ahead");
        assert!(find(root, ACCT, MBOX, 7).is_none(), "no record before the commit");

        let entry = commit(root, ACCT, MBOX, &prepared, &flags(&["flagged"])).unwrap();
        assert_eq!(entry.name, "7.json");
        assert_eq!(entry.flags, flags(&["flagged", "\\Flagged"]), "the flags at commit time");
        verify_prepared(root, ACCT, MBOX, &prepared).unwrap();
        let rec = read_record(&jmap_in(&mailbox_dir(root, ACCT, MBOX)).join("7.json")).unwrap();
        assert_eq!(rec.email["receivedAt"], "2026-10-01T10:00:00Z", "the given INTERNALDATE");

        // A later commit of the same uid keeps the server ids and receivedAt.
        let ids = record::ServerIds { email_id: "M1".into(), blob_id: "G1".into(), thread_id: Some("T1".into()) };
        set_server_ids(root, ACCT, MBOX, 7, ids.clone()).unwrap();
        let again = prepare(root, ACCT, MBOX, 7, eml("seven again"), &[], Some("2030-01-01T00:00:00Z"), Format::Jmap).unwrap();
        commit(root, ACCT, MBOX, &again, &[]).unwrap();
        let rec = read_record(&jmap_in(&mailbox_dir(root, ACCT, MBOX)).join("7.json")).unwrap();
        assert_eq!((rec.server, rec.email["id"].clone(), rec.email["threadId"].clone()), (Some(ids), "M1".into(), "T1".into()));
        assert_eq!(rec.email["receivedAt"], "2026-10-01T10:00:00Z");
        assert_eq!(read_raw(root, ACCT, MBOX, 7).unwrap(), Some(eml("seven again")));
    }

    /// `write_record` is `prepare` and `commit`: the record a writer stores is
    /// byte for byte the one the two halves store.
    #[test]
    fn write_and_prepare_commit_store_the_same_record() {
        let one = vault(Format::Jmap);
        let two = vault(Format::Jmap);
        let raw = b"Message-ID: <a@x>\r\nDate: Thu, 01 Oct 2026 10:00:00 +0200\r\nSubject: same\r\n\r\nbody".to_vec();
        write(one.path(), ACCT, MBOX, 3, &raw, &flags(&["archived", "seen"])).unwrap();
        let prepared = prepare(two.path(), ACCT, MBOX, 3, raw, &flags(&["archived", "seen"]), None, Format::Jmap).unwrap();
        commit(two.path(), ACCT, MBOX, &prepared, &flags(&["archived", "seen"])).unwrap();
        let json = |root: &Path| fs::read(jmap_in(&mailbox_dir(root, ACCT, MBOX)).join("3.json")).unwrap();
        assert_eq!(json(one.path()), json(two.path()));
    }

    /// A Maildir commit replaces the uid's other Maildir names, and its verify
    /// re-reads the file against the prepared bytes.
    #[test]
    fn a_maildir_commit_writes_the_file_and_verifies_it() {
        let tmp = vault(Format::Maildir);
        let root = tmp.path();
        write(root, ACCT, MBOX, 4, &eml("old"), &flags(&["seen"])).unwrap();
        let prepared = prepare(root, ACCT, MBOX, 4, eml("four"), &[], None, Format::Maildir).unwrap();
        assert_eq!(prepared.format(), Format::Maildir);
        let entry = commit(root, ACCT, MBOX, &prepared, &flags(&["flagged"])).unwrap();
        assert_eq!(entry.name, format!("4{INFO_PREFIX}F.eml"));
        assert_eq!(leaf_names(&messages_in(&mailbox_dir(root, ACCT, MBOX)), 4), vec![entry.name.clone()]);
        verify_prepared(root, ACCT, MBOX, &prepared).unwrap();
        fs::write(messages_in(&mailbox_dir(root, ACCT, MBOX)).join(&entry.name), b"changed").unwrap();
        assert!(verify_prepared(root, ACCT, MBOX, &prepared).is_err());
    }

    /// The convert-back carry: the record goes only once the Maildir file to
    /// keep holds the very message the record names.
    #[test]
    fn remove_other_format_keeps_the_record_unless_the_file_holds_its_message() {
        let tmp = vault(Format::Jmap);
        let root = tmp.path();
        write(root, ACCT, MBOX, 7, &eml("seven"), &[]).unwrap();
        let record = jmap_in(&mailbox_dir(root, ACCT, MBOX)).join("7.json");
        let file = messages_in(&mailbox_dir(root, ACCT, MBOX)).join(format!("7{INFO_PREFIX}.eml"));
        fs::create_dir_all(file.parent().unwrap()).unwrap();

        fs::write(&file, eml("other")).unwrap();
        let refused = remove_other_format(root, ACCT, MBOX, 7, Format::Maildir);
        assert!(refused.is_err(), "another message refuses: {refused:?}");
        assert!(record.exists(), "the record survives");

        fs::write(&file, eml("seven")).unwrap();
        assert_eq!(remove_other_format(root, ACCT, MBOX, 7, Format::Maildir), Ok(true));
        assert!(!record.exists());
        assert_eq!(read_raw(root, ACCT, MBOX, 7).unwrap(), Some(eml("seven")));
    }

    /// What the job reads before the lock and checks again under it: a flag
    /// rename keeps a Maildir file's stamp, a rewrite does not; a record's
    /// stamp is its blob id, which a flag rewrite keeps.
    #[test]
    fn held_stamps_follow_the_bytes_not_the_flags() {
        let tmp = vault(Format::Maildir);
        let root = tmp.path();
        write(root, ACCT, MBOX, 5, &eml("five"), &[]).unwrap();
        let (held, raw) = read_held(root, ACCT, MBOX, 5, Format::Maildir).unwrap().unwrap();
        assert_eq!((raw, held.size), (eml("five"), eml("five").len() as u64));
        set_flags(root, ACCT, MBOX, 5, &flags(&["seen"])).unwrap();
        let renamed = held_in(root, ACCT, MBOX, 5, Format::Maildir).unwrap();
        assert_eq!(renamed.stamp, held.stamp, "a flag rename keeps the stamp");
        assert_eq!(renamed.flags, flags(&["seen", "\\Seen"]));
        std::thread::sleep(std::time::Duration::from_millis(5));
        write(root, ACCT, MBOX, 5, &eml("five, rewritten"), &flags(&["seen"])).unwrap();
        assert_ne!(held_in(root, ACCT, MBOX, 5, Format::Maildir).unwrap().stamp, held.stamp);
        assert!(held_in(root, ACCT, MBOX, 5, Format::Jmap).is_none());

        set_vault_format(root, Format::Jmap).unwrap();
        write(root, ACCT, MBOX, 6, &eml("six"), &[]).unwrap();
        let record = held_in(root, ACCT, MBOX, 6, Format::Jmap).unwrap();
        assert_eq!(record.stamp, blobs::blob_id(&eml("six")));
        set_flags(root, ACCT, MBOX, 6, &flags(&["flagged"])).unwrap();
        assert_eq!(held_in(root, ACCT, MBOX, 6, Format::Jmap).unwrap().stamp, record.stamp);
        assert_eq!(read_held(root, ACCT, MBOX, 6, Format::Jmap).unwrap().unwrap().1, eml("six"));

        fs::write(blobs::blob_path(root, &record.stamp), b"junk").unwrap();
        let damaged = read_held(root, ACCT, MBOX, 6, Format::Jmap);
        assert_eq!(damaged.map_err(|e| e.kind()).err(), Some(io::ErrorKind::InvalidData), "a damaged blob is never read as the message");
    }

    #[test]
    fn same_content_compares_the_file_with_the_records_blob() {
        let tmp = vault(Format::Maildir);
        let root = tmp.path();
        write(root, ACCT, MBOX, 1, &eml("one"), &[]).unwrap();
        assert_eq!(same_content(root, ACCT, MBOX, 1), None, "one format only");
        set_vault_format(root, Format::Jmap).unwrap();
        write(root, ACCT, MBOX, 1, &eml("one"), &[]).unwrap();
        assert_eq!(same_content(root, ACCT, MBOX, 1), Some(true));
        write(root, ACCT, MBOX, 1, &eml("uno"), &[]).unwrap();
        assert_eq!(same_content(root, ACCT, MBOX, 1), Some(false));
    }

    /// The old files a retire-mode conversion keeps: the same path below the
    /// mailbox directory, linked or copied, and nothing removed.
    #[test]
    fn retire_format_keeps_the_files_under_their_mailbox_path() {
        let tmp = vault(Format::Maildir);
        let root = tmp.path();
        write(root, ACCT, MBOX, 2, &eml("two"), &flags(&["seen"])).unwrap();
        set_vault_format(root, Format::Jmap).unwrap();
        write(root, ACCT, MBOX, 2, &eml("two"), &flags(&["seen"])).unwrap();
        let dest = root.join("retired/format-x/acct/INBOX");
        for link in [true, false] {
            assert_eq!(retire_format(root, ACCT, MBOX, 2, Format::Maildir, &dest, link).unwrap(), 1);
            assert_eq!(fs::read(dest.join("cur").join(format!("2{INFO_PREFIX}S.eml"))).unwrap(), eml("two"));
            assert_eq!(retire_format(root, ACCT, MBOX, 2, Format::Jmap, &dest, link).unwrap(), 1);
            assert!(dest.join("jmap/2.json").is_file());
        }
        assert!(held_in(root, ACCT, MBOX, 2, Format::Maildir).is_some(), "nothing is removed");
        assert_eq!(retire_format(root, ACCT, MBOX, 9, Format::Maildir, &dest, true).unwrap(), 0);
    }

    #[test]
    fn the_conversion_lists_the_vault_by_format() {
        let tmp = vault(Format::Maildir);
        let root = tmp.path();
        write(root, ACCT, MBOX, 3, &eml("three"), &[]).unwrap();
        write(root, ACCT, MBOX, 1, &eml("one!"), &[]).unwrap();
        write(root, ACCT, "Work", 2, &eml("two"), &[]).unwrap();
        set_vault_format(root, Format::Jmap).unwrap();
        write(root, ACCT, MBOX, 4, &eml("four"), &[]).unwrap();
        write(root, ACCT, MBOX, 1, &eml("one!"), &[]).unwrap();
        fs::create_dir_all(root.join("Maildir/acct/.hidden/cur")).unwrap();
        fs::create_dir_all(root.join("Maildir/acct/empty")).unwrap();

        assert_eq!(mailbox_dirs(root).unwrap(), vec![(ACCT.to_string(), "INBOX".to_string()), (ACCT.to_string(), "Work".to_string())]);
        assert_eq!(uids_in_format(root, ACCT, MBOX, Format::Maildir).unwrap(), vec![1, 3]);
        assert_eq!(uids_in_format(root, ACCT, MBOX, Format::Jmap).unwrap(), vec![1, 4]);
        assert_eq!(uids_in_format(root, ACCT, "Nope", Format::Jmap).unwrap(), Vec::<u32>::new());
        let sizes = |ids: &[&str]| ids.iter().map(|id| eml(id).len() as u64).sum::<u64>();
        assert_eq!(stored_bytes(root, Format::Maildir).unwrap(), sizes(&["three", "one!", "two"]));
        assert_eq!(stored_bytes(root, Format::Jmap).unwrap(), sizes(&["four", "one!"]));
    }

    /// A full disk and an I/O error carry `E_DISK`, which stops a
    /// conversion; any other failure does not.
    #[test]
    fn io_failure_marks_what_the_disk_refused() {
        let full = io::Error::from(io::ErrorKind::StorageFull);
        assert!(io_failure("blob write x", &full).starts_with("E_DISK: blob write x: "));
        assert!(io_failure("w", &io::Error::from(io::ErrorKind::QuotaExceeded)).starts_with("E_DISK: "));
        #[cfg(unix)]
        assert!(io_failure("w", &io::Error::from_raw_os_error(5)).starts_with("E_DISK: "));
        let denied = io_failure("w", &io::Error::from(io::ErrorKind::PermissionDenied));
        assert!(denied.starts_with("w: ") && !denied.contains(E_DISK), "{denied}");
    }

    /// A mailbox directory the listing cannot stat into is an error, not an
    /// empty folder: a conversion that planned without it would end `done`
    /// with the folder still in the old format.
    #[cfg(unix)]
    #[test]
    fn mailbox_dirs_fails_on_a_directory_it_cannot_stat() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = vault(Format::Maildir);
        let root = tmp.path();
        write(root, ACCT, MBOX, 1, &eml("one"), &[]).unwrap();
        write(root, ACCT, "Work", 2, &eml("two"), &[]).unwrap();
        let locked = mailbox_dir(root, ACCT, "Work");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let answer = mailbox_dirs(root);
        let readable = fs::metadata(locked.join("cur")).is_ok();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        if readable {
            return; // root: permissions do not apply
        }
        assert!(answer.is_err(), "an unreadable folder must not read as an empty one: {answer:?}");
    }
}
