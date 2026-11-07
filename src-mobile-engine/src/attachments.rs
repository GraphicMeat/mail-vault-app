//! Attachment downloads into the cache dir: `mobile.attachment.fetch/cancel/local/lease/release`.
//!
//! A part is streamed in [`CHUNK`]-byte range fetches (`BODY.PEEK[section]<offset.len>`, so
//! opening never sets `\Seen`) to `<cache_dir>/att/<hash>.part`, its transfer encoding undone as
//! it arrives ([`Decoder`]: base64 quads and quoted-printable escapes and soft breaks may straddle
//! two chunks). Once the server sends a short slice the file is whole: it is fsynced and renamed
//! to `<hash>`, and only then does `mobile.attachment.local` see it. `<hash>` is a SHA-256 of
//! account, folder, the folder's UIDVALIDITY, uid and section, so a UIDVALIDITY change never
//! serves another message's file. Attachment bytes never cross the RPC bridge (the page gets a
//! path) and never enter `mobile.db`.
//!
//! Resume: after every chunk the `.part` is synced and `<hash>.part.meta` (tmp file + rename)
//! records the raw (transfer-encoded) offset the decoded bytes on disk end at and their length. A
//! decoder holds back at most an unfinished base64 quad or quoted-printable escape or whitespace
//! run; the recorded offset is where that held-back tail starts, so a resume begins with an empty
//! decoder. The next fetch of the part truncates the `.part` to the recorded length (a kill may
//! have left more) and goes on from the recorded offset; a `.part` shorter than that, a meta that
//! does not read, or one for another UIDVALIDITY or encoding starts over.
//!
//! Downloads run on their own worker threads ([`WORKERS`], background QoS), never on the RPC
//! thread; `fetch` returns `{jobId}` at once, and a second fetch of a part that is queued or
//! running returns the same job. Finished files form an LRU of at most [`CACHE_CAP`] bytes by
//! modification time, which `local` and `lease` bump; a leased file (open in the share sheet) is
//! never evicted, and a lease lapses after [`LEASE_TTL`] so a share sheet that crashed cannot pin
//! a file forever.
//!
//! Cleanup on open: a `.part` with no `.part.meta`, or whose meta was last written more than
//! [`STALE_PART`] ago, is deleted with its meta; so are a meta without its `.part` and leftover
//! `.tmp` files.

use crate::db::{lock, Engine, Shared};
use crate::events::{ATTACHMENT_DONE, ATTACHMENT_FAILED, ATTACHMENT_PROGRESS};
use crate::rpc::{parse, RpcError};
use crate::sync::{not_closing, session_config, Fail};
use mailvault_core::imap::{self, ImapPool, ImapSession};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime};

/// Raw (transfer-encoded) octets per range fetch.
pub(crate) const CHUNK: u32 = 256 * 1024;
/// Most bytes of finished files kept.
pub(crate) const CACHE_CAP: u64 = 500 * 1024 * 1024;
/// How long a lease protects a file without a release.
pub(crate) const LEASE_TTL: Duration = Duration::from_secs(10 * 60);
/// A `.part` whose meta was not written for this long is not resumed: it is deleted on open.
pub(crate) const STALE_PART: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// Downloads that run at once; more wait in the queue.
const WORKERS: usize = 2;
const DIR: &str = "att";
const PART: &str = ".part";
const META: &str = ".part.meta";
const TMP: &str = ".tmp";
/// Longest run a quoted-printable decoder holds back (trailing whitespace whose fate the next
/// byte decides); past it the run is written as it is.
const QP_HOLD_MAX: usize = 4096;

// ── Identity ────────────────────────────────────────────────────────────────

/// One part of one message: what a job downloads and what `local` looks up.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PartKey {
    account_id: String,
    folder: String,
    uid: u32,
    section: String,
}

/// The cache file name of a part under the folder's UIDVALIDITY: 64 hex digits. Each field is
/// length-prefixed, so no folder name can make two keys collide.
fn file_name(k: &PartKey, uid_validity: i64) -> String {
    let mut h = Sha256::new();
    h.update(b"mv-attachment-v1");
    for field in [k.account_id.as_bytes(), k.folder.as_bytes(), k.section.as_bytes()] {
        h.update((field.len() as u64).to_le_bytes());
        h.update(field);
    }
    h.update(uid_validity.to_le_bytes());
    h.update(k.uid.to_le_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn is_final_name(name: &str) -> bool {
    name.len() == 64 && name.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `1.2` and the like: dot-separated positive numbers, which is all core will send.
fn valid_section(s: &str) -> bool {
    !s.is_empty() && s.split('.').all(|n| n.parse::<u32>().is_ok_and(|n| n > 0))
}

// ── The job table and workers ───────────────────────────────────────────────

struct Job {
    key: PartKey,
    name: String,
    uid_validity: i64,
    cancel: Arc<AtomicBool>,
}

struct Lease {
    name: String,
    until: Instant,
}

#[derive(Default)]
struct Table {
    next_job: u64,
    next_lease: u64,
    /// Jobs queued or running, by id.
    jobs: HashMap<u64, Job>,
    by_key: HashMap<PartKey, u64>,
    queue: VecDeque<u64>,
    started: bool,
    stop: bool,
    leases: HashMap<u64, Lease>,
}

impl Table {
    /// Names under a live lease; lapsed leases are dropped.
    fn leased(&mut self) -> HashSet<String> {
        let now = Instant::now();
        self.leases.retain(|_, l| l.until > now);
        self.leases.values().map(|l| l.name.clone()).collect()
    }
}

struct State {
    dir: PathBuf,
    table: Mutex<Table>,
    cv: Condvar,
    /// Tests: the largest buffer one job held (raw chunk in, decoded bytes out).
    peak_buffer: AtomicU64,
    /// Unit tests: the cap and the lease lifetime, in place of [`CACHE_CAP`] and [`LEASE_TTL`].
    #[cfg(test)]
    cap: AtomicU64,
    #[cfg(test)]
    lease_ttl_ms: AtomicU64,
    /// Unit tests: runs with the job id after the finished `.part` is synced, before the rename.
    #[cfg(test)]
    before_finish: Mutex<Option<Box<dyn Fn(u64) + Send>>>,
    /// Unit tests: runs in an eviction pass after the scan, before the first delete.
    #[cfg(test)]
    after_scan: Mutex<Option<Box<dyn Fn() + Send>>>,
}

impl State {
    fn cap(&self) -> u64 {
        #[cfg(test)]
        {
            self.cap.load(Ordering::SeqCst)
        }
        #[cfg(not(test))]
        {
            CACHE_CAP
        }
    }

    fn lease_ttl(&self) -> Duration {
        #[cfg(test)]
        {
            Duration::from_millis(self.lease_ttl_ms.load(Ordering::SeqCst))
        }
        #[cfg(not(test))]
        {
            LEASE_TTL
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    fn with_suffix(&self, name: &str, suffix: &str) -> PathBuf {
        self.dir.join(format!("{name}{suffix}"))
    }
}

/// The engine's attachment downloads. Worker threads start with the first fetch.
pub(crate) struct Attachments {
    state: Arc<State>,
}

impl Attachments {
    /// `<cache_dir>/att`, created if missing, with partial files that can no longer resume removed.
    pub(crate) fn open(cache_dir: &Path) -> Attachments {
        let dir = cache_dir.join(DIR);
        let _ = fs::create_dir_all(&dir);
        cleanup(&dir, STALE_PART);
        Attachments {
            state: Arc::new(State {
                dir,
                table: Mutex::new(Table::default()),
                cv: Condvar::new(),
                peak_buffer: AtomicU64::new(0),
                #[cfg(test)]
                cap: AtomicU64::new(CACHE_CAP),
                #[cfg(test)]
                lease_ttl_ms: AtomicU64::new(LEASE_TTL.as_millis() as u64),
                #[cfg(test)]
                before_finish: Mutex::new(None),
                #[cfg(test)]
                after_scan: Mutex::new(None),
            }),
        }
    }

    /// Asks the workers to exit; a running job stops before its next write. Does not wait.
    pub(crate) fn stop(&self) {
        lock(&self.state.table).stop = true;
        self.state.cv.notify_all();
    }

    pub(crate) fn peak_buffer(&self) -> u64 {
        self.state.peak_buffer.load(Ordering::SeqCst)
    }

    /// Queues a download of `key` (file `name`) unless one is queued or running; its job id.
    fn enqueue(&self, shared: &Arc<Shared>, key: PartKey, name: String, uid_validity: i64) -> Result<u64, String> {
        let mut t = lock(&self.state.table);
        if t.stop {
            return Err("the engine is closing".into());
        }
        if let Some(id) = t.by_key.get(&key) {
            return Ok(*id);
        }
        if !t.started {
            for i in 0..WORKERS {
                let (state, shared) = (Arc::clone(&self.state), Arc::clone(shared));
                std::thread::Builder::new()
                    .name(format!("mv-engine-att-{i}"))
                    .spawn(move || worker(state, shared))
                    .map_err(|e| format!("attachment worker: {e}"))?;
            }
            t.started = true;
        }
        t.next_job += 1;
        let id = t.next_job;
        t.by_key.insert(key.clone(), id);
        t.jobs.insert(id, Job { key, name, uid_validity, cancel: Arc::new(AtomicBool::new(false)) });
        t.queue.push_back(id);
        self.state.cv.notify_one();
        Ok(id)
    }
}

fn worker(state: Arc<State>, shared: Arc<Shared>) {
    crate::sync::background_qos();
    loop {
        let (id, key, name, uid_validity, cancel) = {
            let mut t = lock(&state.table);
            loop {
                if t.stop {
                    return;
                }
                if let Some(id) = t.queue.pop_front() {
                    if let Some(j) = t.jobs.get(&id) {
                        break (id, j.key.clone(), j.name.clone(), j.uid_validity, Arc::clone(&j.cancel));
                    }
                    continue;
                }
                t = state.cv.wait(t).unwrap_or_else(|p| p.into_inner());
            }
        };
        let end = run(&state, &shared, id, &key, &name, uid_validity, &cancel);
        // Off the table before the event, so a fetch after `done` starts afresh and a cancel after
        // `failed` reports nothing to cancel.
        {
            let mut t = lock(&state.table);
            t.jobs.remove(&id);
            t.by_key.remove(&key);
        }
        match end {
            End::Done(path) => shared.emit(ATTACHMENT_DONE, json!({ "jobId": id, "path": path.to_string_lossy() })),
            End::Failed(code) => shared.emit(ATTACHMENT_FAILED, json!({ "jobId": id, "code": code })),
            End::Closing => return,
        }
    }
}

// ── One download ────────────────────────────────────────────────────────────

enum End {
    Done(PathBuf),
    Failed(&'static str),
    Closing,
}

/// Why a download stopped before the end.
enum Stop {
    Fail(Fail),
    /// The uid, the part or the folder's UIDVALIDITY is not what was asked for.
    Gone,
    Cancelled,
    /// A slice came back short before the part's reported size and the server still had bytes
    /// after it: the end cannot be trusted, so the file is not finished.
    Short { at: u64, total: u64 },
    Io(io::Error),
}

impl From<Fail> for Stop {
    fn from(f: Fail) -> Self {
        Stop::Fail(f)
    }
}

impl From<String> for Stop {
    fn from(msg: String) -> Self {
        Stop::Fail(Fail::from(msg))
    }
}

impl From<io::Error> for Stop {
    fn from(e: io::Error) -> Self {
        Stop::Io(e)
    }
}

/// What `<hash>.part.meta` holds: where the decoded bytes on disk end, in raw and decoded octets.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Meta {
    uid_validity: i64,
    encoding: String,
    raw_offset: u64,
    decoded_len: u64,
}

fn run(state: &State, shared: &Shared, id: u64, key: &PartKey, name: &str, uid_validity: i64, cancel: &AtomicBool) -> End {
    let final_path = state.path(name);
    let out = (|| -> Result<(), Stop> {
        // A job cancelled while it waited in the queue ends before any network work.
        checkpoint(shared, cancel)?;
        if final_path.is_file() {
            // Another job (or an earlier run) finished it.
            touch(&final_path)?;
            return Ok(());
        }
        let sc = session_config(shared, &key.account_id)?;
        crate::net::block_on(async {
            let pool = ImapPool::new();
            let mut session = imap::create_imap_session(&sc.config, &pool).await?;
            let out = download(state, shared, &mut session, id, key, name, uid_validity, cancel).await;
            let _ = session.logout().await;
            out
        })
        .map_err(|s| match s {
            Stop::Fail(f) => Stop::Fail(sc.scrub(f)),
            other => other,
        })
    })();
    match out {
        Ok(()) => {
            evict(state, name);
            End::Done(final_path)
        }
        Err(Stop::Fail(Fail::Closing)) => End::Closing,
        Err(Stop::Fail(Fail::Gone)) | Err(Stop::Gone) => {
            remove_partial(state, name);
            End::Failed("GONE")
        }
        Err(Stop::Cancelled) => {
            remove_partial(state, name);
            End::Failed("CANCELLED")
        }
        Err(Stop::Fail(Fail::Code(code, why))) => {
            shared.log(&format!("[attachment] {} {} {} {}: {} {}", key.account_id, key.folder, key.uid, key.section, code.as_str(), why));
            End::Failed(code.as_str())
        }
        Err(Stop::Short { at, total }) => {
            shared.log(&format!(
                "[attachment] {} {} {} {}: short slice at {at} of {total}, but the part goes on",
                key.account_id, key.folder, key.uid, key.section
            ));
            End::Failed("INVALID")
        }
        Err(Stop::Io(e)) => {
            shared.log(&format!("[attachment] {} {} {} {}: io {}", key.account_id, key.folder, key.uid, key.section, e));
            End::Failed("INVALID")
        }
    }
}

/// Stops the job when the engine closed or the job was cancelled: checked after every network
/// return and before every file write, so a job that outlives its engine never writes again.
fn checkpoint(shared: &Shared, cancel: &AtomicBool) -> Result<(), Stop> {
    not_closing(shared)?;
    if cancel.load(Ordering::SeqCst) {
        return Err(Stop::Cancelled);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn download(
    state: &State,
    shared: &Shared,
    session: &mut ImapSession,
    id: u64,
    key: &PartKey,
    name: &str,
    uid_validity: i64,
    cancel: &AtomicBool,
) -> Result<(), Stop> {
    // Selects the folder, proves the uid is there under the same UIDVALIDITY and names the part's
    // encoding; every range fetch after it runs on this selection.
    let (parts, validity) = imap::fetch_parts(session, &key.folder, key.uid).await?;
    checkpoint(shared, cancel)?;
    let Some(parts) = parts else {
        return Err(Stop::Gone);
    };
    if validity.map(i64::from) != Some(uid_validity) {
        return Err(Stop::Gone);
    }
    let Some(part) = parts.into_iter().find(|p| p.section == key.section) else {
        return Err(Stop::Gone);
    };
    let total = part.size as u64;
    let (part_path, meta_path) = (state.with_suffix(name, PART), state.with_suffix(name, META));
    let (mut file, mut meta) = resume(&part_path, &meta_path, uid_validity, &part.encoding)?;
    let mut decoder = Decoder::new(&part.encoding);
    // Where the next range starts; `meta.raw_offset` lags it by what the decoder holds back.
    let mut offset = meta.raw_offset;
    let mut out = Vec::new();
    loop {
        let data = imap::fetch_selected_section_range(session, &key.folder, key.uid, &key.section, offset, CHUNK).await?;
        checkpoint(shared, cancel)?;
        let Some(data) = data else {
            return Err(Stop::Gone);
        };
        let last = data.len() < CHUNK as usize;
        let end_at = offset + data.len() as u64;
        if last && end_at < total {
            // Short before the size the server reported: a server may end a slice early. The end
            // is real only when the next offset has nothing.
            let probe = imap::fetch_selected_section_range(session, &key.folder, key.uid, &key.section, end_at, CHUNK).await?;
            checkpoint(shared, cancel)?;
            match probe {
                None => return Err(Stop::Gone),
                Some(p) if p.is_empty() => {}
                Some(_) => return Err(Stop::Short { at: end_at, total }),
            }
        }
        out.clear();
        decoder.feed(&data, &mut out);
        offset += data.len() as u64;
        if last {
            decoder.finish(&mut out);
        }
        state.peak_buffer.fetch_max(data.len().max(out.len()).max(decoder.held()) as u64, Ordering::SeqCst);
        drop(data);
        file.write_all(&out)?;
        meta.decoded_len += out.len() as u64;
        if last {
            file.sync_all()?;
            drop(file);
            #[cfg(test)]
            if let Some(hook) = lock(&state.before_finish).as_ref() {
                hook(id);
            }
            {
                // Under the table lock, which `cancel` also takes: a cancel lands either before
                // this (the job ends CANCELLED, no file) or after it (the job is already off the
                // table and the cancel answers false). Never a cancelled job that ends `done`.
                let mut t = lock(&state.table);
                if cancel.load(Ordering::SeqCst) {
                    return Err(Stop::Cancelled);
                }
                fs::rename(&part_path, state.path(name))?;
                t.jobs.remove(&id);
                t.by_key.remove(key);
            }
            sync_dir(&state.dir);
            let _ = fs::remove_file(&meta_path);
            return Ok(());
        }
        // Data before meta: a meta never claims bytes the disk may not hold.
        file.sync_data()?;
        meta.raw_offset = offset - decoder.held() as u64;
        write_meta(&meta_path, &meta)?;
        shared.emit(ATTACHMENT_PROGRESS, json!({ "jobId": id, "received": offset, "total": total }));
    }
}

/// Opens the `.part` to append to, resuming what its meta vouches for, else from scratch.
fn resume(part_path: &Path, meta_path: &Path, uid_validity: i64, encoding: &str) -> Result<(File, Meta), Stop> {
    let encoding = encoding.to_ascii_lowercase();
    let found: Option<Meta> = fs::read(meta_path).ok().and_then(|b| serde_json::from_slice(&b).ok());
    let on_disk = fs::metadata(part_path).map(|m| m.len()).ok();
    if let (Some(meta), Some(len)) = (found, on_disk) {
        if meta.uid_validity == uid_validity && meta.encoding == encoding && len >= meta.decoded_len {
            let file = OpenOptions::new().write(true).open(part_path)?;
            // A kill between the data write and the meta write leaves bytes the meta never vouched for.
            file.set_len(meta.decoded_len)?;
            let mut file = file;
            io::Seek::seek(&mut file, io::SeekFrom::End(0))?;
            return Ok((file, meta));
        }
    }
    let file = OpenOptions::new().write(true).create(true).truncate(true).open(part_path)?;
    let meta = Meta { uid_validity, encoding, raw_offset: 0, decoded_len: 0 };
    // A meta from the start, so the cleanup on open never mistakes a fresh `.part` for an orphan.
    write_meta(meta_path, &meta)?;
    Ok((file, meta))
}

fn write_meta(path: &Path, meta: &Meta) -> io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(TMP);
    let tmp = PathBuf::from(tmp);
    let bytes = serde_json::to_vec(meta).map_err(io::Error::other)?;
    {
        let mut f = File::create(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_data()?;
    }
    fs::rename(&tmp, path)
}

/// Makes a rename durable where the platform allows it (not on Windows, where a directory cannot
/// be opened as a file).
fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

fn remove_partial(state: &State, name: &str) {
    for suffix in [PART, META] {
        let _ = fs::remove_file(state.with_suffix(name, suffix));
    }
}

/// Stamps the file as just opened (its LRU position). Windows needs a handle opened for writing.
fn touch(path: &Path) -> io::Result<()> {
    OpenOptions::new().write(true).open(path)?.set_modified(SystemTime::now())
}

/// Deletes partial downloads that cannot resume: a `.part` without its meta or whose meta is older
/// than `stale`, a meta without its `.part`, and leftover tmp files.
fn cleanup(dir: &Path, stale: Duration) {
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    let names: Vec<String> = rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    let now = SystemTime::now();
    let age = |p: &Path| fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| now.duration_since(t).ok());
    for n in &names {
        let path = dir.join(n);
        if n.ends_with(TMP) {
            let _ = fs::remove_file(&path);
        } else if let Some(base) = n.strip_suffix(META) {
            if !names.iter().any(|m| m.strip_suffix(PART) == Some(base)) {
                let _ = fs::remove_file(&path);
            }
        } else if let Some(base) = n.strip_suffix(PART) {
            let meta = dir.join(format!("{base}{META}"));
            let keep = meta.is_file() && age(&meta).is_some_and(|a| a < stale);
            if !keep {
                let _ = fs::remove_file(&path);
                let _ = fs::remove_file(&meta);
            }
        }
    }
}

/// Deletes the least recently opened finished files until the total is at most the cap, never
/// `keep` (the file just finished) and never a leased one.
fn evict(state: &State, keep: &str) -> usize {
    // The scan and the sort run without the table lock, so a foreground fetch or lease never
    // waits on a directory pass. Each delete takes the lock for that one file and re-checks the
    // leases there: a lease (taken under the lock after checking the file is there) either lands
    // first and the file is skipped, or finds the file gone.
    let Ok(rd) = fs::read_dir(&state.dir) else {
        return 0;
    };
    let mut files: Vec<(SystemTime, u64, String)> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if !is_final_name(&name) {
                return None;
            }
            let m = e.metadata().ok()?;
            Some((m.modified().unwrap_or(SystemTime::UNIX_EPOCH), m.len(), name))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    let cap = state.cap();
    if total <= cap {
        return 0;
    }
    files.sort();
    #[cfg(test)]
    if let Some(hook) = lock(&state.after_scan).as_ref() {
        hook();
    }
    let mut removed = 0;
    for (_, len, name) in files {
        if total <= cap {
            break;
        }
        if name == keep {
            continue;
        }
        let mut t = lock(&state.table);
        if t.leased().contains(&name) {
            continue;
        }
        if fs::remove_file(state.path(&name)).is_ok() {
            total -= len;
            removed += 1;
        }
        drop(t);
    }
    removed
}

// ── Incremental transfer decoding ───────────────────────────────────────────

/// Undoes a transfer encoding chunk by chunk. `held()` is how many raw bytes at the end of what
/// was fed are not decoded yet (an unfinished base64 quad with the whitespace inside it, or a
/// quoted-printable escape or whitespace run whose meaning the next byte decides); a resume
/// restarts at that many bytes before the end, with a fresh decoder.
enum Decoder {
    Identity,
    Base64 {
        quad: [u8; 4],
        n: usize,
        /// Raw bytes since the quad's first character, that character included.
        held: usize,
    },
    Qp {
        held: Vec<u8>,
    },
}

fn b64_value(b: u8) -> Option<u8> {
    match b {
        b'A'..=b'Z' => Some(b - b'A'),
        b'a'..=b'z' => Some(b - b'a' + 26),
        b'0'..=b'9' => Some(b - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn hex_value(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'A'..=b'F' => Some(b - b'A' + 10),
        b'a'..=b'f' => Some(b - b'a' + 10),
        _ => None,
    }
}

fn is_blank(b: u8) -> bool {
    b == b' ' || b == b'\t'
}

impl Decoder {
    fn new(encoding: &str) -> Decoder {
        match encoding.trim().to_ascii_lowercase().as_str() {
            "base64" => Decoder::Base64 { quad: [0; 4], n: 0, held: 0 },
            "quoted-printable" => Decoder::Qp { held: Vec::new() },
            _ => Decoder::Identity,
        }
    }

    fn held(&self) -> usize {
        match self {
            Decoder::Identity => 0,
            Decoder::Base64 { held, .. } => *held,
            Decoder::Qp { held } => held.len(),
        }
    }

    fn feed(&mut self, data: &[u8], out: &mut Vec<u8>) {
        match self {
            Decoder::Identity => out.extend_from_slice(data),
            Decoder::Base64 { quad, n, held } => {
                out.reserve(data.len() / 4 * 3 + 3);
                for &b in data {
                    if let Some(v) = b64_value(b) {
                        quad[*n] = v;
                        *n += 1;
                        if *n == 4 {
                            out.extend_from_slice(&[quad[0] << 2 | quad[1] >> 4, quad[1] << 4 | quad[2] >> 2, quad[2] << 6 | quad[3]]);
                            *n = 0;
                            *held = 0;
                        } else {
                            *held += 1;
                        }
                    } else if b == b'=' {
                        // Padding ends the quad: what it holds is one or two bytes.
                        flush_quad(quad, *n, out);
                        *n = 0;
                        *held = 0;
                    } else if *n > 0 {
                        // Line breaks and stray characters inside a quad are skipped, but held.
                        *held += 1;
                    }
                }
            }
            Decoder::Qp { held } => {
                let buf: Cow<[u8]> = if held.is_empty() {
                    Cow::Borrowed(data)
                } else {
                    let mut b = std::mem::take(held);
                    b.extend_from_slice(data);
                    Cow::Owned(b)
                };
                let used = qp_decode(&buf, false, out);
                *held = buf[used..].to_vec();
            }
        }
    }

    /// The input ended: decodes whatever was held back.
    fn finish(&mut self, out: &mut Vec<u8>) {
        match self {
            Decoder::Identity => {}
            Decoder::Base64 { quad, n, held } => {
                flush_quad(quad, *n, out);
                *n = 0;
                *held = 0;
            }
            Decoder::Qp { held } => {
                let buf = std::mem::take(held);
                qp_decode(&buf, true, out);
            }
        }
    }
}

/// The bytes a quad cut short by padding (or by the end) carries: two characters make one byte,
/// three make two; one alone makes none.
fn flush_quad(quad: &[u8; 4], n: usize, out: &mut Vec<u8>) {
    if n >= 2 {
        out.push(quad[0] << 2 | quad[1] >> 4);
    }
    if n >= 3 {
        out.push(quad[1] << 4 | quad[2] >> 2);
    }
}

/// Decodes quoted-printable from `buf` into `out` as far as the bytes decide, and returns how many
/// bytes it used; the rest waits for more input. RFC 2045 6.7 with a lenient reader's rules: `=XX`
/// is a byte, `=` before a line break (whitespace allowed between) is a soft break, a `=` that is
/// neither is itself, blanks before a line break are transport padding and dropped, and a hard
/// line break (LF or CRLF) comes out as CRLF, as core's whole-part decode writes it. At the
/// `end`, a trailing `=` and trailing blanks are dropped too.
fn qp_decode(buf: &[u8], end: bool, out: &mut Vec<u8>) -> usize {
    out.reserve(buf.len());
    let len = buf.len();
    let mut i = 0;
    while i < len {
        let b = buf[i];
        if b == b'=' {
            let j = i + 1;
            if j == len {
                if end {
                    return len;
                }
                return i;
            }
            match buf[j] {
                h if hex_value(h).is_some() => {
                    if j + 1 == len && !end {
                        return i;
                    }
                    match buf.get(j + 1).copied().and_then(hex_value) {
                        Some(lo) => {
                            out.push(hex_value(h).unwrap() << 4 | lo);
                            i += 3;
                        }
                        None => {
                            out.push(b'=');
                            i += 1;
                        }
                    }
                }
                b'\n' => i = j + 1,
                b'\r' => match buf.get(j + 1) {
                    Some(b'\n') => i = j + 2,
                    None if !end => return i,
                    None => return len,
                    Some(_) => {
                        out.push(b'=');
                        i += 1;
                    }
                },
                c if is_blank(c) => {
                    let mut k = j;
                    while k < len && is_blank(buf[k]) {
                        k += 1;
                    }
                    match buf.get(k) {
                        None if end => return len,
                        None if k - i <= QP_HOLD_MAX => return i,
                        Some(b'\n') => i = k + 1,
                        Some(b'\r') if buf.get(k + 1) == Some(&b'\n') => i = k + 2,
                        Some(b'\r') if k + 1 == len && !end => return i,
                        _ => {
                            out.push(b'=');
                            i += 1;
                        }
                    }
                }
                _ => {
                    out.push(b'=');
                    i += 1;
                }
            }
        } else if is_blank(b) {
            let mut k = i + 1;
            while k < len && is_blank(buf[k]) {
                k += 1;
            }
            let trailing = match buf.get(k) {
                None if end => true,
                None if k - i <= QP_HOLD_MAX => return i,
                Some(b'\n') => true,
                Some(b'\r') if buf.get(k + 1) == Some(&b'\n') => true,
                Some(b'\r') if k + 1 == len && !end && k - i <= QP_HOLD_MAX => return i,
                _ => false,
            };
            if !trailing {
                out.extend_from_slice(&buf[i..k]);
            }
            i = k;
        } else if b == b'\n' {
            // A hard line break is CRLF, as core's whole-part decode writes it.
            out.extend_from_slice(b"\r\n");
            i += 1;
        } else if b == b'\r' {
            match buf.get(i + 1) {
                Some(b'\n') => {
                    out.extend_from_slice(b"\r\n");
                    i += 2;
                }
                None if !end => return i,
                _ => {
                    out.push(b'\r');
                    i += 1;
                }
            }
        } else {
            // Plain bytes up to the next one that needs a look.
            let mut k = i + 1;
            while k < len && !matches!(buf[k], b'=' | b'\r' | b'\n') && !is_blank(buf[k]) {
                k += 1;
            }
            out.extend_from_slice(&buf[i..k]);
            i = k;
        }
    }
    len
}

// ── RPCs ────────────────────────────────────────────────────────────────────

fn internal(e: impl ToString) -> RpcError {
    RpcError::Internal(e.to_string())
}

/// The part's file name under the folder's stored UIDVALIDITY. `INVALID` for a bad section or a
/// folder the engine does not know; `Ok(None)` for a folder never selected (no UIDVALIDITY yet).
fn name_of(shared: &Shared, key: &PartKey) -> Result<Option<(String, i64)>, RpcError> {
    if !valid_section(&key.section) {
        return Err(RpcError::Invalid(format!("not a part section: {}", key.section)));
    }
    let row: Option<Option<i64>> = shared
        .read(|c| {
            c.query_row("SELECT uid_validity FROM folders WHERE account_id = ?1 AND path = ?2", (&key.account_id, &key.folder), |r| r.get(0))
                .optional()
        })
        .map_err(internal)?;
    let Some(validity) = row else {
        return Err(RpcError::Invalid("unknown folder".into()));
    };
    Ok(validity.map(|v| (file_name(key, v), v)))
}

/// `mobile.attachment.fetch {accountId, folder, uid, section}` -> `{jobId}`, at once. The job
/// ends with `mobile.attachment.done {jobId, path}` or `mobile.attachment.failed {jobId, code}`
/// and reports `mobile.attachment.progress {jobId, received, total}` on the way. A part already
/// queued or downloading answers with its running job.
pub(crate) fn fetch(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let key: PartKey = parse(params)?;
    let shared = engine.shared();
    let Some((name, validity)) = name_of(shared, &key)? else {
        return Err(RpcError::Invalid("the folder has not been synced".into()));
    };
    let id = engine.attachments().enqueue(shared, key, name, validity).map_err(RpcError::Internal)?;
    Ok(json!({ "jobId": id }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JobParams {
    job_id: u64,
}

/// `mobile.attachment.cancel {jobId}` -> `{cancelled}`: false when the job already ended. A
/// cancelled job deletes its `.part` and ends with `failed` `CANCELLED`.
pub(crate) fn cancel(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: JobParams = parse(params)?;
    let state = &engine.attachments().state;
    let found = match lock(&state.table).jobs.get(&p.job_id) {
        Some(j) => {
            j.cancel.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    };
    // A job still in the queue is picked up, sees the flag before any network work, and ends.
    Ok(json!({ "cancelled": found }))
}

/// `mobile.attachment.local {accountId, folder, uid, section}` -> `{path}`: the finished file, or
/// null when there is none (never fetched, still downloading, or purged: fetch again). A hit
/// counts as opening the file for the LRU.
pub(crate) fn local(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let key: PartKey = parse(params)?;
    let Some((name, _)) = name_of(engine.shared(), &key)? else {
        return Ok(json!({ "path": null }));
    };
    let path = engine.attachments().state.path(&name);
    match touch(&path) {
        Ok(()) => Ok(json!({ "path": path.to_string_lossy() })),
        Err(_) => Ok(json!({ "path": null })),
    }
}

/// Perf-gate seed only: `bytes` as the finished cache file of one part, as if it had been fetched
/// (no server stands behind the seed account), so the device check can open and share it. Written
/// beside the final name and renamed into place. A file already there is left alone.
#[cfg(feature = "perf-gate")]
pub(crate) fn seed_file(engine: &Engine, account_id: &str, folder: &str, uid: u32, section: &str, bytes: &[u8]) -> Result<(), String> {
    let key = PartKey { account_id: account_id.into(), folder: folder.into(), uid, section: section.into() };
    let Some((name, _)) = name_of(engine.shared(), &key).map_err(|e| e.to_string())? else {
        return Err("the folder has no UIDVALIDITY".into());
    };
    let state = &engine.attachments().state;
    let path = state.path(&name);
    if path.is_file() {
        return Ok(());
    }
    let tmp = state.with_suffix(&name, TMP);
    fs::write(&tmp, bytes).and_then(|()| fs::rename(&tmp, &path)).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LeaseParams {
    path: String,
}

/// `mobile.attachment.lease {path}` -> `{leaseId, ttlMs}`: eviction skips the file until
/// `mobile.attachment.release {leaseId}` or until the lease lapses. Leasing a file that already
/// has a live lease renews it and answers the same `leaseId`. `path` must be a finished
/// file this engine handed out.
pub(crate) fn lease(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: LeaseParams = parse(params)?;
    let state = &engine.attachments().state;
    let path = Path::new(&p.path);
    let name = match (path.parent(), path.file_name().and_then(|n| n.to_str())) {
        (Some(dir), Some(n)) if dir == state.dir && is_final_name(n) => n.to_string(),
        _ => return Err(RpcError::Invalid("not an attachment file".into())),
    };
    let ttl = state.lease_ttl();
    // Under the table lock, which eviction holds across its deletes: the file is either still
    // there (and now leased) or already gone.
    let mut t = lock(&state.table);
    if touch(path).is_err() {
        return Err(RpcError::Invalid("the file is gone".into()));
    }
    let until = Instant::now() + ttl;
    t.leased();
    // A live lease on the same file is renewed (a resumed share sheet leases again), not doubled.
    if let Some((id, l)) = t.leases.iter_mut().find(|(_, l)| l.name == name) {
        l.until = until;
        return Ok(json!({ "leaseId": *id, "ttlMs": ttl.as_millis() as u64 }));
    }
    t.next_lease += 1;
    let id = t.next_lease;
    t.leases.insert(id, Lease { name, until });
    Ok(json!({ "leaseId": id, "ttlMs": ttl.as_millis() as u64 }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseParams {
    lease_id: u64,
}

/// `mobile.attachment.release {leaseId}` -> `{released}`: false when the lease had lapsed or was
/// released already.
pub(crate) fn release(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: ReleaseParams = parse(params)?;
    let mut t = lock(&engine.attachments().state.table);
    let now = Instant::now();
    let released = t.leases.remove(&p.lease_id).is_some_and(|l| l.until > now);
    Ok(json!({ "released": released }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_split(data: &[u8], encoding: &str, splits: &[usize]) -> Vec<u8> {
        let mut d = Decoder::new(encoding);
        let mut out = Vec::new();
        let mut from = 0;
        for &s in splits.iter().chain(std::iter::once(&data.len())) {
            d.feed(&data[from..s], &mut out);
            from = s;
        }
        d.finish(&mut out);
        out
    }

    fn samples() -> Vec<(&'static str, Vec<u8>)> {
        let mut b64 = Vec::new();
        for _ in 0..40 {
            b64.extend_from_slice(b"QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0\r\n");
        }
        b64.extend_from_slice(b"QUI=\r\n");
        vec![
            ("base64", b"aGVs\r\nbG8gd29y\r\nbGQ=\r\n".to_vec()),
            ("base64", b"aGVsbG8=".to_vec()),
            ("base64", b"aGVsbA==\r\n".to_vec()),
            ("base64", b64),
            ("quoted-printable", b"caf=C3=A9 =\r\nbar  \r\nGr=c3=bc=C3=9Fe =3D=\r\nend \t\r\n=\r\nx = y =ZZ =\r".to_vec()),
            ("quoted-printable", b"soft =  \r\nbreak=\nlf only  \nlast line no eol  ".to_vec()),
            ("quoted-printable", b"trailing equals=".to_vec()),
            ("7bit", b"as is \r\n".to_vec()),
        ]
    }

    /// Split at every byte (and at every pair of bytes for the short inputs), the streaming decode
    /// equals core's whole-buffer decode.
    #[test]
    fn decoder_matches_whole_decode_at_every_split() {
        for (enc, data) in samples() {
            let whole = mailvault_core::imap::parts::decode_transfer(&data, enc);
            assert_eq!(decode_split(&data, enc, &[]), whole, "{enc} {:?}", String::from_utf8_lossy(&data));
            for s in 0..=data.len() {
                assert_eq!(decode_split(&data, enc, &[s]), whole, "{enc} split at {s}: {:?}", String::from_utf8_lossy(&data));
            }
            if data.len() <= 80 {
                for a in 0..=data.len() {
                    for b in a..=data.len() {
                        assert_eq!(decode_split(&data, enc, &[a, b]), whole, "{enc} splits {a},{b}");
                    }
                }
            }
        }
    }

    /// What `held()` reports is exactly what a resume must re-read: decoding the rest from that
    /// offset with a fresh decoder, after the bytes already out, gives the whole decode.
    #[test]
    fn held_marks_the_resume_offset() {
        for (enc, data) in samples() {
            let whole = mailvault_core::imap::parts::decode_transfer(&data, enc);
            for s in 0..=data.len() {
                let mut d = Decoder::new(enc);
                let mut out = Vec::new();
                d.feed(&data[..s], &mut out);
                let resume_at = s - d.held();
                let mut fresh = Decoder::new(enc);
                fresh.feed(&data[resume_at..], &mut out);
                fresh.finish(&mut out);
                assert_eq!(out, whole, "{enc} resumed at {resume_at} after a stop at {s}");
            }
        }
    }

    #[test]
    fn file_names_are_stable_and_distinct() {
        let k = |a: &str, f: &str, uid: u32, s: &str| PartKey { account_id: a.into(), folder: f.into(), uid, section: s.into() };
        let n = file_name(&k("acct", "INBOX", 7, "2"), 42);
        assert!(is_final_name(&n), "{n}");
        // Fixed: a name a build wrote must still be found after an update.
        assert_eq!(n, file_name(&k("acct", "INBOX", 7, "2"), 42));
        assert_ne!(n, file_name(&k("acct", "INBOX", 7, "2"), 43), "UIDVALIDITY is part of the name");
        assert_ne!(file_name(&k("ab", "c", 1, "1"), 1), file_name(&k("a", "bc", 1, "1"), 1));
        assert!(valid_section("1.2") && !valid_section("") && !valid_section("0") && !valid_section("2 BODY[]"));
    }

    fn engine() -> (tempfile::TempDir, Engine) {
        let tmp = tempfile::tempdir().unwrap();
        let e = Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(crate::MemorySecrets::default())).unwrap();
        (tmp, e)
    }

    /// A finished file of `len` bytes, last opened `age` ago.
    fn finished(state: &State, seed: u8, len: usize, age: Duration) -> (String, PathBuf) {
        let name = format!("{:064x}", seed);
        let path = state.path(&name);
        fs::write(&path, vec![seed; len]).unwrap();
        OpenOptions::new().write(true).open(&path).unwrap().set_modified(SystemTime::now() - age).unwrap();
        (name, path)
    }

    fn set_age(path: &Path, age: Duration) {
        OpenOptions::new().write(true).open(path).unwrap().set_modified(SystemTime::now() - age).unwrap();
    }

    /// Past the cap the least recently opened files go first; a leased file is skipped until its
    /// lease is released or lapses, and the file just finished always stays.
    #[test]
    fn evicts_lru_past_cap_except_leased() {
        let (_tmp, e) = engine();
        let state = &e.attachments().state;
        state.cap.store(3_000, Ordering::SeqCst);
        let (_n1, p1) = finished(state, 1, 1_000, Duration::from_secs(50));
        let (_n2, p2) = finished(state, 2, 1_000, Duration::from_secs(40));
        let (_n3, p3) = finished(state, 3, 1_000, Duration::from_secs(30));
        let (n4, p4) = finished(state, 4, 1_000, Duration::from_secs(1));
        let lease = |p: &Path| e.rpc("mobile.attachment.lease", json!({ "path": p.to_string_lossy() })).unwrap()["leaseId"].as_u64().unwrap();

        // 1 is the oldest (leased long ago, as a share sheet left open would be) but leased: 2 goes.
        let l1 = lease(&p1);
        set_age(&p1, Duration::from_secs(60));
        assert_eq!(evict(state, &n4), 1);
        assert!(p1.is_file() && !p2.exists() && p3.is_file() && p4.is_file());

        // Released, it is the first to go.
        assert_eq!(e.rpc("mobile.attachment.release", json!({ "leaseId": l1 })).unwrap()["released"], true);
        let (n5, p5) = finished(state, 5, 1_000, Duration::ZERO);
        assert_eq!(evict(state, &n5), 1);
        assert!(!p1.exists() && p3.is_file() && p4.is_file() && p5.is_file());

        // A lapsed lease protects nothing; the file just finished survives even a cap of zero.
        state.lease_ttl_ms.store(1, Ordering::SeqCst);
        let l3 = lease(&p3);
        set_age(&p3, Duration::from_secs(30));
        std::thread::sleep(Duration::from_millis(20));
        state.cap.store(0, Ordering::SeqCst);
        assert_eq!(evict(state, &n5), 2);
        assert!(!p3.exists() && !p4.exists() && p5.is_file());
        assert_eq!(e.rpc("mobile.attachment.release", json!({ "leaseId": l3 })).unwrap()["released"], false);

        // `local` hands out paths; only a finished file in the cache dir can be leased.
        assert!(e.rpc("mobile.attachment.lease", json!({ "path": "/etc/hosts" })).is_err());
        let part = state.with_suffix(&n5, PART);
        fs::write(&part, b"x").unwrap();
        assert!(e.rpc("mobile.attachment.lease", json!({ "path": part.to_string_lossy() })).is_err());
        assert!(e.rpc("mobile.attachment.lease", json!({ "path": p4.to_string_lossy() })).is_err(), "an evicted file was leased");
    }

    /// A live lease on the same file is renewed, not doubled: the renewal keeps it protected
    /// past the first lease's expiry.
    #[test]
    fn leasing_again_renews_the_lease() {
        let (_tmp, e) = engine();
        let state = &e.attachments().state;
        state.lease_ttl_ms.store(1_000, Ordering::SeqCst);
        let (_, p1) = finished(state, 1, 1_000, Duration::from_secs(60));
        let (n2, _p2) = finished(state, 2, 1_000, Duration::ZERO);
        let lease = |p: &Path| e.rpc("mobile.attachment.lease", json!({ "path": p.to_string_lossy() })).unwrap()["leaseId"].as_u64().unwrap();
        let l = lease(&p1);
        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(lease(&p1), l, "a second lease of a leased file is the same lease");
        std::thread::sleep(Duration::from_millis(600));
        // 1.2 s after the first lease (past its 1 s), 0.6 s after the renewal: still protected.
        set_age(&p1, Duration::from_secs(60));
        state.cap.store(0, Ordering::SeqCst);
        assert_eq!(evict(state, &n2), 0);
        assert!(p1.is_file());
        assert_eq!(e.rpc("mobile.attachment.release", json!({ "leaseId": l })).unwrap()["released"], true);
        assert_eq!(evict(state, &n2), 1);
        assert!(!p1.exists());
    }

    /// A lease that lands after an eviction pass scanned the directory but before it deletes is
    /// still respected: the lease is re-checked per file under the lock.
    #[test]
    fn a_lease_between_scan_and_delete_is_respected() {
        let (_tmp, e) = engine();
        let state = &e.attachments().state;
        state.cap.store(1_000, Ordering::SeqCst);
        let (n1, p1) = finished(state, 1, 1_000, Duration::from_secs(60));
        let (_n2, p2) = finished(state, 2, 1_000, Duration::from_secs(30));
        let (n3, p3) = finished(state, 3, 1_000, Duration::ZERO);
        let weak = Arc::downgrade(&e.attachments().state);
        *lock(&state.after_scan) = Some(Box::new(move || {
            let st = weak.upgrade().unwrap();
            let mut t = lock(&st.table);
            t.next_lease += 1;
            let id = t.next_lease;
            t.leases.insert(id, Lease { name: n1.clone(), until: Instant::now() + Duration::from_secs(60) });
        }));
        assert_eq!(evict(state, &n3), 1);
        assert!(p1.is_file(), "the file leased mid-pass was deleted");
        assert!(!p2.exists() && p3.is_file());
    }

    /// A cancel that lands after the last slice is written but before the rename wins: no
    /// finished file, no `done`, the job ends CANCELLED; a cancel after that answers false.
    #[test]
    fn a_cancel_just_before_the_rename_wins() {
        use mock_imap::state::{Mailbox, Message};
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let raw = "From: a <a@example.com>\r\nSubject: s\r\nMessage-ID: <c@x>\r\nMIME-Version: 1.0\r\n\
             Content-Type: multipart/mixed; boundary=\"m\"\r\n\r\n--m\r\nContent-Type: text/plain\r\n\r\nhi\r\n\
             --m\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=\"x.bin\"\r\n\
             Content-Transfer-Encoding: base64\r\n\r\naGVsbG8gd29ybGQ=\r\n--m--\r\n";
        let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_millis() as i64;
        let mut mb = Mailbox::new("INBOX");
        mb.add(Message::new(1, raw).with_internal_ms(now - 86_400_000));
        let server = mock_imap::MockImap::start(mock_imap::Scenario::new().mailbox(mb));
        let (_tmp, e) = engine();
        let events: Arc<(Mutex<Vec<(String, Value)>>, Condvar)> = Arc::default();
        let sink = Arc::clone(&events);
        e.set_event_sink(move |n, v| {
            sink.0.lock().unwrap().push((n.to_string(), v));
            sink.1.notify_all();
        });
        let added = e
            .rpc(
                "mobile.accounts.add",
                json!({ "email": "u@example.test", "password": "pw", "imapHost": server.host(), "imapPort": server.port(), "security": "none" }),
            )
            .unwrap();
        let account = added["account"]["id"].as_str().unwrap().to_string();
        crate::sync::sync_now_for_test(e.shared(), &account, None);

        let weak = Arc::downgrade(&e.attachments().state);
        *lock(&e.attachments().state.before_finish) = Some(Box::new(move |id| {
            let st = weak.upgrade().unwrap();
            let t = lock(&st.table);
            t.jobs[&id].cancel.store(true, Ordering::SeqCst);
        }));
        let part = json!({ "accountId": account, "folder": "INBOX", "uid": 1, "section": "2" });
        let job = e.rpc("mobile.attachment.fetch", part.clone()).unwrap()["jobId"].as_u64().unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        let mut list = events.0.lock().unwrap();
        let end = loop {
            if let Some(hit) = list.iter().find(|(n, v)| n.starts_with("mobile.attachment.") && n != "mobile.attachment.progress" && v["jobId"] == job) {
                break hit.clone();
            }
            assert!(Instant::now() < deadline, "no end: {list:?}");
            list = events.1.wait_timeout(list, Duration::from_millis(200)).unwrap().0;
        };
        drop(list);
        assert_eq!(end.0, ATTACHMENT_FAILED, "{end:?}");
        assert_eq!(end.1["code"], "CANCELLED");
        assert_eq!(e.rpc("mobile.attachment.local", part).unwrap()["path"], Value::Null);
        assert_eq!(fs::read_dir(&e.attachments().state.dir).unwrap().count(), 0, "files left behind");
        assert_eq!(e.rpc("mobile.attachment.cancel", json!({ "jobId": job })).unwrap()["cancelled"], false);
    }

    /// Open deletes partial files that cannot resume and keeps the ones that can.
    #[test]
    fn open_removes_partials_that_cannot_resume() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("cache").join(DIR);
        fs::create_dir_all(&dir).unwrap();
        let meta = |name: &str, age: Duration| {
            let p = dir.join(format!("{name}{META}"));
            fs::write(&p, b"{}").unwrap();
            OpenOptions::new().write(true).open(&p).unwrap().set_modified(SystemTime::now() - age).unwrap();
        };
        let (fresh, stale, orphan, lone_meta, done) = ("a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64), "e".repeat(64));
        for n in [&fresh, &stale, &orphan] {
            fs::write(dir.join(format!("{n}{PART}")), b"x").unwrap();
        }
        meta(&fresh, Duration::from_secs(60));
        meta(&stale, STALE_PART + Duration::from_secs(60));
        meta(&lone_meta, Duration::ZERO);
        fs::write(dir.join(&done), b"done").unwrap();
        fs::write(dir.join(format!("{fresh}{META}{TMP}")), b"half").unwrap();
        let e = Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(crate::MemorySecrets::default())).unwrap();
        let mut left: Vec<String> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, [format!("{fresh}{PART}"), format!("{fresh}{META}"), done.clone()]);
        drop(e);
    }
}
