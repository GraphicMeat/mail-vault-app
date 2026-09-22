//! What the vault holds, answered from a database instead of the disk
//! (architecture.md "Reads come from the database").
//!
//! `<app_dir>/vault_registry.db` records, per `(account_id, vault_dir, uid)`,
//! the file name, its size and mtime, and the parsed light row. It is derived
//! and droppable: any open error, a schema bump or a different vault root
//! deletes it and starts empty, and it is never in custody.
//!
//! - A mailbox is listed at most once per daemon session ("verified", held in
//!   memory, never persisted) and again only after `invalidate` or a stored
//!   name that no longer opens. A verified miss is authoritative.
//! - Writers update the rows themselves right after their fs op (`upsert`,
//!   `rename`, `remove`); structural changes `invalidate`.
//! - Verify never parses. A new or changed file gets `light_row = NULL`, and
//!   `light_rows` parses it on first read, once.
//! - Keyed by `vault_dir_name(mailbox)`, not the raw mailbox, because that is
//!   the directory on disk: `A/B` and `A_B` are one folder and one row set.
//!
//! Race fences, since no lock is held across a listing: every row write
//! stamps a fresh `seq`, and applying a listing leaves any row stamped after
//! the listing began alone. `remove` leaves a tombstone (`filename = NULL`) so
//! there is a `seq` to fence even for a uid the registry never held. Every
//! invalidate bumps that mailbox's generation (`invalidate_all` a global
//! one); a listing that raced one is applied but does not mark the mailbox
//! verified.
//!
//! Lock order: per-mailbox lock, then the vault gate (repair only), then
//! custody, then the registry connection. The connection is never held across
//! a listing or a parse.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::UNIX_EPOCH;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use tracing::warn;

use crate::search_index::reconcile::{read_cur, DiskFile};
use crate::search_index::text::vault_dir_name;
use crate::vault_eml::{light_row_json, parse_flags_from_filename};

pub const DB_FILE: &str = "vault_registry.db";
const SCHEMA_VERSION: &str = "1";

/// No migrations: a different version drops the file.
const SCHEMA: &str = "
CREATE TABLE files (
  account_id TEXT NOT NULL,
  vault_dir  TEXT NOT NULL,
  uid        INTEGER NOT NULL,
  filename   TEXT,
  size       INTEGER NOT NULL,
  mtime_ns   INTEGER NOT NULL,
  seq        INTEGER NOT NULL,
  light_row  TEXT,
  PRIMARY KEY (account_id, vault_dir, uid)
) WITHOUT ROWID;
";

/// Stored in `light_row` for a file that does not parse as mail, so it is
/// parsed once like any other and then skipped by `light_rows`.
const UNPARSEABLE: &str = "";

/// What changed, for the daemon's search-index nudge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    Mailbox { account: String, vault_dir: String },
    All,
}

type Key = (String, String);

/// One listing of a mailbox's `cur`, with the `seq` and generations read before
/// `read_dir` started.
pub(crate) struct Listing {
    files: HashMap<u32, DiskFile>,
    unstatted: HashSet<u32>,
    s0: i64,
    e0: (u64, u64),
}

/// The verified mailboxes and the generations that fence them, under one
/// mutex so an invalidate can never land between a verify's check and its
/// insert. Per mailbox, so a flag change elsewhere never fails this verify.
#[derive(Default)]
struct Verified {
    set: HashSet<Key>,
    all: u64,
    gens: HashMap<Key, u64>,
}

impl Verified {
    fn epoch(&self, key: &Key) -> (u64, u64) {
        (self.all, self.gens.get(key).copied().unwrap_or(0))
    }
}

pub struct VaultRegistry {
    conn: Mutex<Option<Connection>>,
    verified: Mutex<Verified>,
    mailbox_locks: Mutex<HashMap<Key, Arc<Mutex<()>>>>,
    seq: AtomicI64,
    on_change: OnceLock<Box<dyn Fn(Scope) + Send + Sync>>,
    listings: AtomicUsize,
    parses: AtomicUsize,
}

fn guard<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn key(account: &str, mailbox: &str) -> Key {
    (account.to_string(), vault_dir_name(mailbox))
}

fn cur_dir(root: &Path, account: &str, vault_dir: &str) -> PathBuf {
    // account is NOT sanitized: see `vault_files::cur_path`.
    root.join("Maildir").join(account).join(vault_dir).join("cur")
}

fn mtime_ns(meta: &std::fs::Metadata) -> i64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as i64)
}

fn is_archived(filename: &str) -> bool {
    parse_flags_from_filename(filename).iter().any(|f| f == "archived")
}

fn open_at(path: &Path, root: &str) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    let mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(rusqlite::Error::InvalidQuery);
    }
    conn.execute_batch("PRAGMA synchronous=NORMAL;")?;
    init(&conn, root)?;
    Ok(conn)
}

/// A fresh database gets the schema; an existing one must carry this version
/// and this root, or it is an error (and the caller drops the file).
fn init(conn: &Connection, root: &str) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);")?;
    let get = |k: &str| conn.query_row("SELECT value FROM meta WHERE key = ?1", [k], |r| r.get::<_, String>(0)).optional();
    match get("schema_version")? {
        None => conn.execute_batch(&format!(
            "BEGIN; {SCHEMA} INSERT INTO meta(key, value) VALUES ('schema_version', '{SCHEMA_VERSION}'); COMMIT;"
        ))?,
        Some(v) if v == SCHEMA_VERSION => {}
        Some(_) => return Err(rusqlite::Error::InvalidQuery),
    }
    match get("root")? {
        None => {
            conn.execute("INSERT INTO meta(key, value) VALUES ('root', ?1)", [root])?;
        }
        Some(r) if r == root => {}
        Some(_) => return Err(rusqlite::Error::InvalidQuery),
    }
    conn.query_row("SELECT account_id, vault_dir, uid, filename, size, mtime_ns, seq, light_row FROM files LIMIT 0", [], |_| Ok(()))
        .optional()?;
    Ok(())
}

impl VaultRegistry {
    /// Opens `<app_dir>/vault_registry.db` for the vault at `root`. Never
    /// fails: a file that cannot be used is deleted and recreated, and if that
    /// fails too the registry runs in memory for this session.
    pub fn open(app_dir: &Path, root: &Path) -> VaultRegistry {
        let path = app_dir.join(DB_FILE);
        let root = root.to_string_lossy();
        let conn = open_at(&path, &root)
            .or_else(|e| {
                warn!("vault_registry: {} unusable ({e}); recreating", path.display());
                for suffix in ["", "-wal", "-shm"] {
                    let _ = std::fs::remove_file(app_dir.join(format!("{DB_FILE}{suffix}")));
                }
                open_at(&path, &root)
            })
            .or_else(|e| {
                warn!("vault_registry: recreate failed ({e}); keeping it in memory");
                let conn = Connection::open_in_memory()?;
                init(&conn, &root)?;
                Ok::<_, rusqlite::Error>(conn)
            })
            .map_err(|e| warn!("vault_registry: no registry this session: {e}"))
            .ok();
        // A new session continues the stored seqs: restarting at 0 would make
        // every surviving row look newer than the first listing, never applied.
        let seq = conn
            .as_ref()
            .and_then(|c| c.query_row("SELECT COALESCE(MAX(seq), 0) FROM files", [], |r| r.get(0)).ok())
            .unwrap_or(0);
        VaultRegistry {
            conn: Mutex::new(conn),
            verified: Mutex::new(Verified::default()),
            mailbox_locks: Mutex::new(HashMap::new()),
            seq: AtomicI64::new(seq),
            on_change: OnceLock::new(),
            listings: AtomicUsize::new(0),
            parses: AtomicUsize::new(0),
        }
    }

    /// Called after every write and invalidate, with no registry lock held
    /// but possibly under the caller's: a writer or a generation repair runs
    /// inside `serialized`, so the per-mailbox lock can be held. The callback
    /// must therefore never read the registry synchronously (a verify would
    /// wait on that lock); the daemon's index nudge and sweep are channel
    /// sends. Set once; a second call is ignored.
    pub fn set_on_change(&self, f: Box<dyn Fn(Scope) + Send + Sync>) {
        let _ = self.on_change.set(f);
    }

    /// How many `cur` listings this registry has made (test seam).
    pub fn listing_count(&self) -> usize {
        self.listings.load(Ordering::SeqCst)
    }

    /// How many files `light_rows` has parsed (test seam).
    pub fn parse_count(&self) -> usize {
        self.parses.load(Ordering::SeqCst)
    }

    /// Runs `f` under the mailbox's lock, the one verification takes, so a
    /// generation repair never interleaves with a listing. Never call a
    /// registry read from inside `f`: the lock is not reentrant.
    pub fn serialized<T>(&self, account: &str, mailbox: &str, f: impl FnOnce() -> T) -> T {
        let lock = self.mailbox_lock(&key(account, mailbox));
        let _held = guard(&lock);
        f()
    }

    /// `(saved, archived)` uids, ascending. `None` when the mailbox cannot be
    /// verified: unknown, never empty.
    pub fn uid_sets(&self, root: &Path, account: &str, mailbox: &str) -> Option<(Vec<u32>, Vec<u32>)> {
        let (account, dir) = key(account, mailbox);
        self.ensure_verified(root, &account, &dir)?;
        let rows = self.live_rows(&account, &dir, None)?;
        let archived = rows.iter().filter(|r| is_archived(&r.1)).map(|r| r.0).collect();
        Some((rows.into_iter().map(|r| r.0).collect(), archived))
    }

    /// The light rows (headers, attachment list, `snippet`, no body) for
    /// `uids` in request order, or the whole mailbox by uid. `uid`, `flags` and
    /// `isArchived` come from the current file name. Uids not held, and files
    /// that are not mail, are left out. `None` when the mailbox cannot be
    /// verified.
    pub fn light_rows(&self, root: &Path, account: &str, mailbox: &str, uids: Option<&[u32]>) -> Option<Vec<Value>> {
        let (account, dir) = key(account, mailbox);
        let mut retried = false;
        loop {
            self.ensure_verified(root, &account, &dir)?;
            let rows = self.live_rows(&account, &dir, uids)?;
            let cur = cur_dir(root, &account, &dir);
            let mut out = Vec::with_capacity(rows.len());
            let mut parsed = Vec::new();
            let mut unreadable = false;
            for (uid, filename, seq, light_row) in rows {
                let json = match light_row {
                    Some(json) => json,
                    None => {
                        // No connection lock is held here: parsing is the slow part.
                        let raw = match std::fs::read(cur.join(&filename)) {
                            Ok(raw) => raw,
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                                // A vanished name: the disk changed under us.
                                unreadable = true;
                                continue;
                            }
                            Err(e) => {
                                // The message is there but will not read (EIO,
                                // EACCES). Leaving it out would answer "not
                                // held"; only non-mail files may be left out.
                                warn!("vault_registry: read {account}/{dir}/{filename}: {e}");
                                self.store_parsed(&account, &dir, &parsed);
                                return None;
                            }
                        };
                        self.parses.fetch_add(1, Ordering::SeqCst);
                        let json = light_row_json(&raw, uid).unwrap_or_else(|| UNPARSEABLE.to_string());
                        parsed.push((uid, seq, json.clone()));
                        json
                    }
                };
                let Ok(mut row) = serde_json::from_str::<Value>(&json) else { continue };
                let Some(obj) = row.as_object_mut() else { continue };
                let flags = parse_flags_from_filename(&filename);
                obj.insert("uid".into(), uid.into());
                obj.insert("isArchived".into(), flags.iter().any(|f| f == "archived").into());
                obj.insert("flags".into(), serde_json::json!(flags));
                out.push(row);
            }
            self.store_parsed(&account, &dir, &parsed);
            if unreadable && !retried {
                // A stored name that no longer opens: the disk changed under
                // us. Relist once and answer from that.
                retried = true;
                self.invalidate_dir(&account, &dir);
                continue;
            }
            return Some(out);
        }
    }

    /// The file holding `uid`: `Some(Some(path))`, `Some(None)` when the
    /// verified mailbox does not hold it, `None` when the mailbox cannot be
    /// verified or read (unknown, never absent). See `with_resolved` for reads
    /// that recover.
    pub fn resolve(&self, root: &Path, account: &str, mailbox: &str, uid: u32) -> Option<Option<PathBuf>> {
        let (account, dir) = key(account, mailbox);
        self.ensure_verified(root, &account, &dir)?;
        let row = self.live_rows(&account, &dir, Some(&[uid]))?.pop();
        Some(row.map(|r| cur_dir(root, &account, &dir).join(r.1)))
    }

    /// What the registry already knows about `uid`, without listing: `None`
    /// while the mailbox is not verified (or the read failed), `Some(None)`
    /// for a verified miss, `Some(Some(filename))` for a live row. Takes no
    /// mailbox lock, so a writer holding the vault gate may call it (the lock
    /// order puts the mailbox lock before the gate).
    pub fn known(&self, account: &str, mailbox: &str, uid: u32) -> Option<Option<String>> {
        let (account, dir) = key(account, mailbox);
        if !self.is_verified(&account, &dir) {
            return None;
        }
        Some(self.live_rows(&account, &dir, Some(&[uid]))?.pop().map(|r| r.1))
    }

    /// Resolve `uid` and run `f` on its path. An `f` error of kind `NotFound`
    /// means the stored name no longer opens: the mailbox is invalidated,
    /// relisted once, and `f` retried once on the fresh answer. Any other
    /// error is `f`'s own and returned as is. A uid the mailbox does not hold
    /// is `NotFound`; a mailbox that cannot be verified is another error.
    pub fn with_resolved<T>(
        &self,
        root: &Path,
        account: &str,
        mailbox: &str,
        uid: u32,
        mut f: impl FnMut(&Path) -> std::io::Result<T>,
    ) -> std::io::Result<T> {
        use std::io::{Error, ErrorKind};
        let (account_k, dir) = key(account, mailbox);
        let mut retried = false;
        loop {
            let path = match self.resolve(root, account, mailbox, uid) {
                Some(Some(path)) => path,
                // A verified miss is absent: no relisting for it.
                Some(None) => return Err(ErrorKind::NotFound.into()),
                None => return Err(Error::other("vault folder could not be listed or read")),
            };
            match f(&path) {
                Err(e) if e.kind() == ErrorKind::NotFound && !retried => {
                    retried = true;
                    self.invalidate_dir(&account_k, &dir);
                }
                other => return other,
            }
        }
    }

    /// A writer put `path` (a file in the mailbox's `cur`) in place for `uid`.
    /// Stats it and records it with no light row. A failed stat invalidates.
    ///
    /// The stat and the seq are taken under the connection lock. Taken before
    /// it, an upsert that queued behind a delete of the same uid would write
    /// its live row after the delete's tombstone, and `uid_sets` (which never
    /// opens a file) would call the deleted message saved all session. Under
    /// the lock it finds the file gone and invalidates instead. Callers still
    /// serialize same-mailbox writers (`serialized`) for the mirror case: a
    /// delete that unlinks first and writes its tombstone after a re-store.
    pub fn upsert(&self, account: &str, mailbox: &str, uid: u32, path: &Path) {
        let (account, dir) = key(account, mailbox);
        let Some(filename) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            return self.invalidate_dir(&account, &dir);
        };
        self.write(&account, &dir, |conn, seq| {
            let Ok(meta) = std::fs::metadata(path) else { return Ok(false) };
            let size = i64::try_from(meta.len()).unwrap_or(i64::MAX);
            let mtime = mtime_ns(&meta);
            conn.execute(
                "INSERT INTO files (account_id, vault_dir, uid, filename, size, mtime_ns, seq, light_row) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)
                 ON CONFLICT (account_id, vault_dir, uid) DO UPDATE SET filename = excluded.filename, size = excluded.size,
                   mtime_ns = excluded.mtime_ns, seq = excluded.seq, light_row = NULL",
                params![account, dir, uid, filename, size, mtime, seq],
            )
            .map(|_| true)
        });
    }

    /// A writer renamed `uid`'s file to `new_filename` in place (a flag
    /// change): same content, so the light row is kept. A uid with no live row
    /// invalidates, since the registry did not know the file.
    pub fn rename(&self, account: &str, mailbox: &str, uid: u32, new_filename: &str) {
        let (account, dir) = key(account, mailbox);
        self.write(&account, &dir, |conn, seq| {
            conn.execute(
                "UPDATE files SET filename = ?4, seq = ?5 WHERE account_id = ?1 AND vault_dir = ?2 AND uid = ?3 AND filename IS NOT NULL",
                params![account, dir, uid, new_filename, seq],
            )
            .map(|n| n == 1)
        });
    }

    /// A writer deleted the files for `uids`. Leaves tombstones, so a listing
    /// taken before the delete cannot bring them back.
    pub fn remove(&self, account: &str, mailbox: &str, uids: &[u32]) {
        if uids.is_empty() {
            return;
        }
        let (account, dir) = key(account, mailbox);
        self.write(&account, &dir, |conn, seq| {
            let tx = conn.transaction()?;
            {
                let mut st = tx.prepare_cached(
                    "INSERT INTO files (account_id, vault_dir, uid, filename, size, mtime_ns, seq, light_row) VALUES (?1, ?2, ?3, NULL, 0, 0, ?4, NULL)
                     ON CONFLICT (account_id, vault_dir, uid) DO UPDATE SET filename = NULL, light_row = NULL, seq = excluded.seq",
                )?;
                for uid in uids {
                    st.execute(params![account, dir, uid, seq])?;
                }
            }
            tx.commit().map(|_| true)
        });
    }

    /// The mailbox's directory changed in ways no single write describes: the
    /// next read lists it again. Rows stay, so unchanged files keep their parse.
    pub fn invalidate(&self, account: &str, mailbox: &str) {
        let (account, dir) = key(account, mailbox);
        self.invalidate_dir(&account, &dir);
    }

    /// Every mailbox is listed again on its next read (vault reopen, startup migration).
    pub fn invalidate_all(&self) {
        {
            let mut verified = guard(&self.verified);
            verified.all += 1;
            verified.set.clear();
        }
        self.changed(Scope::All);
    }

    // ── internals ────────────────────────────────────────────────────────────

    fn next_seq(&self) -> i64 {
        self.seq.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn changed(&self, scope: Scope) {
        if let Some(f) = self.on_change.get() {
            f(scope);
        }
    }

    fn mailbox_lock(&self, key: &Key) -> Arc<Mutex<()>> {
        Arc::clone(guard(&self.mailbox_locks).entry(key.clone()).or_default())
    }

    fn is_verified(&self, account: &str, dir: &str) -> bool {
        guard(&self.verified).set.contains(&(account.to_string(), dir.to_string()))
    }

    fn invalidate_dir(&self, account: &str, dir: &str) {
        {
            let key = (account.to_string(), dir.to_string());
            let mut verified = guard(&self.verified);
            *verified.gens.entry(key.clone()).or_default() += 1;
            verified.set.remove(&key);
        }
        self.changed(Scope::Mailbox { account: account.to_string(), vault_dir: dir.to_string() });
    }

    /// One row write. `op` gets the connection and a seq taken under its
    /// lock, so rows land in seq order. It returns whether it touched what it
    /// meant to; a miss or an error invalidates, so a failed write never
    /// leaves a stale verified answer behind.
    fn write(&self, account: &str, dir: &str, op: impl FnOnce(&mut Connection, i64) -> rusqlite::Result<bool>) {
        let result = match guard(&self.conn).as_mut() {
            Some(conn) => op(conn, self.next_seq()),
            None => Ok(false),
        };
        match result {
            Ok(true) => self.changed(Scope::Mailbox { account: account.to_string(), vault_dir: dir.to_string() }),
            Ok(false) => self.invalidate_dir(account, dir),
            Err(e) => {
                warn!("vault_registry: write {account}/{dir}: {e}");
                self.invalidate_dir(account, dir);
            }
        }
    }

    /// `(uid, filename, seq, light_row)` of live rows, for `uids` in request
    /// order or the whole mailbox by uid.
    #[allow(clippy::type_complexity)]
    fn live_rows(&self, account: &str, dir: &str, uids: Option<&[u32]>) -> Option<Vec<(u32, String, i64, Option<String>)>> {
        let conn_guard = guard(&self.conn);
        let conn = conn_guard.as_ref()?;
        let map = |r: &rusqlite::Row| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?));
        let rows = match uids {
            None => conn
                .prepare_cached(
                    "SELECT uid, filename, seq, light_row FROM files WHERE account_id = ?1 AND vault_dir = ?2 AND filename IS NOT NULL ORDER BY uid",
                )
                .and_then(|mut st| st.query_map(params![account, dir], map)?.collect()),
            Some(uids) => conn
                .prepare_cached(
                    "SELECT uid, filename, seq, light_row FROM files WHERE account_id = ?1 AND vault_dir = ?2 AND uid = ?3 AND filename IS NOT NULL",
                )
                .and_then(|mut st| {
                    let mut out = Vec::with_capacity(uids.len());
                    for uid in uids {
                        if let Some(row) = st.query_row(params![account, dir, uid], map).optional()? {
                            out.push(row);
                        }
                    }
                    Ok(out)
                }),
        };
        rows.map_err(|e| warn!("vault_registry: read {account}/{dir}: {e}")).ok()
    }

    /// Keeps parses whose row has not been rewritten since it was read.
    fn store_parsed(&self, account: &str, dir: &str, parsed: &[(u32, i64, String)]) {
        if parsed.is_empty() {
            return;
        }
        let mut conn_guard = guard(&self.conn);
        let Some(conn) = conn_guard.as_mut() else { return };
        let result = (|| -> rusqlite::Result<()> {
            let tx = conn.transaction()?;
            {
                let mut st = tx.prepare_cached(
                    "UPDATE files SET light_row = ?5 WHERE account_id = ?1 AND vault_dir = ?2 AND uid = ?3 AND seq = ?4 AND light_row IS NULL",
                )?;
                for (uid, seq, json) in parsed {
                    st.execute(params![account, dir, uid, seq, json])?;
                }
            }
            tx.commit()
        })();
        if let Err(e) = result {
            // Only a cache fill: the next read parses again.
            warn!("vault_registry: store light rows {account}/{dir}: {e}");
        }
    }

    /// Lists the mailbox once per session. `None` when it cannot be listed, or
    /// when a racing invalidate or a mid-rename uid left the listing short.
    fn ensure_verified(&self, root: &Path, account: &str, dir: &str) -> Option<()> {
        if self.is_verified(account, dir) {
            return Some(());
        }
        let key = (account.to_string(), dir.to_string());
        let lock = self.mailbox_lock(&key);
        let _held = guard(&lock);
        for _ in 0..2 {
            if self.is_verified(account, dir) {
                return Some(());
            }
            let listing = self.list_mailbox(root, account, dir)?;
            if self.apply_listing(account, dir, listing) {
                return Some(());
            }
        }
        None
    }

    /// Lists `cur`. A missing `cur` under a present vault root is an empty
    /// folder; any other error, or a missing root (an unmounted drive), is
    /// `None`: unknown.
    pub(crate) fn list_mailbox(&self, root: &Path, account: &str, dir: &str) -> Option<Listing> {
        let s0 = self.seq.load(Ordering::SeqCst);
        let e0 = guard(&self.verified).epoch(&(account.to_string(), dir.to_string()));
        self.listings.fetch_add(1, Ordering::SeqCst);
        let (files, unstatted) = match read_cur(&cur_dir(root, account, dir)) {
            Ok(listing) => listing,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && root.is_dir() => Default::default(),
            Err(e) => {
                warn!("vault_registry: list {account}/{dir}: {e}");
                return None;
            }
        };
        Some(Listing { files, unstatted, s0, e0 })
    }

    /// Reconciles the rows with `listing` and returns whether the mailbox is
    /// now verified. Rows written after the listing began (`seq > s0`) are
    /// left alone. Same size and mtime under a new name is a rename and keeps
    /// the light row; any other change clears it.
    pub(crate) fn apply_listing(&self, account: &str, dir: &str, listing: Listing) -> bool {
        let Listing { files, unstatted, s0, e0 } = listing;
        let mut conn_guard = guard(&self.conn);
        let Some(conn) = conn_guard.as_mut() else { return false };
        let seq = self.next_seq();
        let result = (|| -> rusqlite::Result<bool> {
            let tx = conn.transaction()?;
            let rows: HashMap<u32, (Option<String>, i64, i64, i64)> = {
                let mut st = tx.prepare_cached(
                    "SELECT uid, filename, size, mtime_ns, seq FROM files WHERE account_id = ?1 AND vault_dir = ?2",
                )?;
                let rows = st.query_map(params![account, dir], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            {
                let mut upsert = tx.prepare_cached(
                    "INSERT INTO files (account_id, vault_dir, uid, filename, size, mtime_ns, seq, light_row) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)
                     ON CONFLICT (account_id, vault_dir, uid) DO UPDATE SET filename = excluded.filename, size = excluded.size,
                       mtime_ns = excluded.mtime_ns, seq = excluded.seq, light_row = NULL",
                )?;
                let mut rename = tx.prepare_cached(
                    "UPDATE files SET filename = ?4, seq = ?5 WHERE account_id = ?1 AND vault_dir = ?2 AND uid = ?3",
                )?;
                let mut delete = tx.prepare_cached("DELETE FROM files WHERE account_id = ?1 AND vault_dir = ?2 AND uid = ?3")?;
                for (uid, file) in &files {
                    match rows.get(uid) {
                        Some((_, _, _, row_seq)) if *row_seq > s0 => {}
                        Some((Some(name), size, mtime, _)) if *size == file.size && *mtime == file.mtime_ns => {
                            if *name != file.filename {
                                rename.execute(params![account, dir, uid, file.filename, seq])?;
                            }
                        }
                        _ => {
                            upsert.execute(params![account, dir, uid, file.filename, file.size, file.mtime_ns, seq])?;
                        }
                    }
                }
                for (uid, (_, _, _, row_seq)) in &rows {
                    if *row_seq <= s0 && !files.contains_key(uid) && !unstatted.contains(uid) {
                        delete.execute(params![account, dir, uid])?;
                    }
                }
            }
            tx.commit()?;
            // A uid whose stat failed mid-listing is still there under another
            // name. With no live row for it, a verified answer would call it absent.
            Ok(unstatted.iter().all(|uid| matches!(rows.get(uid), Some((Some(_), ..)))))
        })();
        drop(conn_guard);
        let complete = match result {
            Ok(complete) => complete,
            Err(e) => {
                warn!("vault_registry: apply {account}/{dir}: {e}");
                return false;
            }
        };
        let key = (account.to_string(), dir.to_string());
        let mut verified = guard(&self.verified);
        if complete && verified.epoch(&key) == e0 {
            verified.set.insert(key);
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const ACCT: &str = "acct";
    const MB: &str = "INBOX";

    struct Fixture {
        _tmp: tempfile::TempDir,
        app: PathBuf,
        root: PathBuf,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let app = tmp.path().join("app");
        let root = tmp.path().join("vault");
        fs::create_dir_all(&app).unwrap();
        fs::create_dir_all(&root).unwrap();
        Fixture { _tmp: tmp, app, root }
    }

    fn cur(f: &Fixture, mailbox: &str) -> PathBuf {
        crate::vault_files::cur_path(&f.root, ACCT, mailbox)
    }

    fn put(f: &Fixture, mailbox: &str, name: &str) -> PathBuf {
        let dir = cur(f, mailbox);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        let uid = name.split(':').next().unwrap();
        fs::write(&path, format!("From: a@x.test\r\nSubject: m{uid}\r\n\r\nbody of {uid}\r\n")).unwrap();
        path
    }

    fn row_count(reg: &VaultRegistry, uid: u32) -> i64 {
        let g = guard(&reg.conn);
        g.as_ref().unwrap().query_row("SELECT COUNT(*) FROM files WHERE uid = ?1", [uid], |r| r.get(0)).unwrap()
    }

    fn saved(reg: &VaultRegistry, f: &Fixture, mailbox: &str) -> Vec<u32> {
        reg.uid_sets(&f.root, ACCT, mailbox).unwrap().0
    }

    #[test]
    fn an_upsert_after_verify_is_read_back_without_a_listing() {
        let f = fixture();
        put(&f, MB, "1:2,S.eml");
        let reg = VaultRegistry::open(&f.app, &f.root);
        assert_eq!(saved(&reg, &f, MB), vec![1]);
        let path = put(&f, MB, "2:2,.eml");
        reg.upsert(ACCT, MB, 2, &path);
        assert_eq!(saved(&reg, &f, MB), vec![1, 2]);
        assert_eq!(reg.listing_count(), 1);
    }

    #[test]
    fn a_flag_rename_moves_the_uid_to_archived_and_keeps_the_parse() {
        let f = fixture();
        let old = put(&f, MB, "4:2,S.eml");
        let reg = VaultRegistry::open(&f.app, &f.root);
        let rows = reg.light_rows(&f.root, ACCT, MB, None).unwrap();
        assert_eq!(rows[0]["isArchived"], false);
        assert_eq!(reg.parse_count(), 1);

        fs::rename(&old, cur(&f, MB).join("4:2,AS.eml")).unwrap();
        reg.rename(ACCT, MB, 4, "4:2,AS.eml");

        assert_eq!(reg.uid_sets(&f.root, ACCT, MB).unwrap(), (vec![4], vec![4]));
        let rows = reg.light_rows(&f.root, ACCT, MB, Some(&[4])).unwrap();
        assert_eq!(rows[0]["isArchived"], true);
        assert_eq!(rows[0]["subject"], "m4");
        assert!(rows[0]["flags"].as_array().unwrap().iter().any(|f| f == "archived"));
        assert_eq!(reg.parse_count(), 1, "a rename never reparses");
        assert_eq!(reg.listing_count(), 1);
    }

    #[test]
    fn an_external_delete_is_found_by_the_failed_open_and_one_relisting() {
        let f = fixture();
        let path = put(&f, MB, "3:2,S.eml");
        let reg = VaultRegistry::open(&f.app, &f.root);
        assert!(reg.resolve(&f.root, ACCT, MB, 3).unwrap().is_some());
        assert_eq!(reg.listing_count(), 1);

        fs::remove_file(&path).unwrap();
        let mut calls = 0;
        let err = reg.with_resolved(&f.root, ACCT, MB, 3, |p| { calls += 1; fs::read(p) }).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
        assert_eq!(calls, 1, "the relisting finds it absent, so no second open");
        assert_eq!(reg.listing_count(), 2);
        assert_eq!(reg.resolve(&f.root, ACCT, MB, 3), Some(None));
        assert_eq!(row_count(&reg, 3), 0, "the row is gone");
        assert_eq!(reg.listing_count(), 2);
    }

    #[test]
    fn with_resolved_retries_once_on_a_file_renamed_behind_its_back() {
        let f = fixture();
        let path = put(&f, MB, "5:2,.eml");
        let reg = VaultRegistry::open(&f.app, &f.root);
        assert!(reg.resolve(&f.root, ACCT, MB, 5).unwrap().is_some());
        fs::rename(&path, cur(&f, MB).join("5:2,S.eml")).unwrap();
        let bytes = reg.with_resolved(&f.root, ACCT, MB, 5, |p| fs::read(p)).unwrap();
        assert!(!bytes.is_empty());
        assert_eq!(reg.listing_count(), 2);
        // An error that is not NotFound is the closure's own: no relisting.
        let err = reg.with_resolved(&f.root, ACCT, MB, 5, |_| -> std::io::Result<()> { Err(std::io::ErrorKind::InvalidData.into()) });
        assert_eq!(err.unwrap_err().kind(), std::io::ErrorKind::InvalidData);
        assert_eq!(reg.listing_count(), 2);
    }

    /// Unknown is not absent: a mailbox that cannot be verified, or a row read
    /// that fails, is an error of another kind than `NotFound`, so a caller
    /// never reads "could not tell" as "gone".
    #[test]
    fn with_resolved_reports_unknown_apart_from_absent() {
        let f = fixture();
        put(&f, MB, "5:2,.eml");
        let file_cur = cur(&f, "Broken");
        fs::create_dir_all(file_cur.parent().unwrap()).unwrap();
        fs::write(&file_cur, b"not a dir").unwrap();
        let reg = VaultRegistry::open(&f.app, &f.root);

        let err = reg.with_resolved(&f.root, ACCT, "Broken", 5, |p| fs::read(p)).unwrap_err();
        assert_ne!(err.kind(), std::io::ErrorKind::NotFound, "an unlistable folder is unknown");
        assert_eq!(reg.resolve(&f.root, ACCT, "Broken", 5), None);

        let err = reg.with_resolved(&f.root, ACCT, MB, 6, |p| fs::read(p)).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound, "a verified miss is absent");

        *guard(&reg.conn) = None; // the row read itself fails
        assert_eq!(reg.resolve(&f.root, ACCT, MB, 5), None);
        let err = reg.with_resolved(&f.root, ACCT, MB, 5, |p| fs::read(p)).unwrap_err();
        assert_ne!(err.kind(), std::io::ErrorKind::NotFound, "a failed read is unknown");
    }

    /// A message that is there but will not read is not left out of the
    /// answer: the whole answer is unknown.
    #[cfg(unix)]
    #[test]
    fn a_held_file_that_will_not_read_makes_light_rows_unknown() {
        use std::os::unix::fs::PermissionsExt;
        let f = fixture();
        put(&f, MB, "1:2,.eml");
        let locked = put(&f, MB, "2:2,.eml");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let reg = VaultRegistry::open(&f.app, &f.root);
        let rows = reg.light_rows(&f.root, ACCT, MB, None);
        let as_root = fs::read(&locked).is_ok();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o644)).unwrap();
        if as_root {
            return; // permissions aren't enforced, nothing to prove
        }
        assert_eq!(rows, None);
        assert_eq!(reg.light_rows(&f.root, ACCT, MB, None).unwrap().len(), 2, "readable again, answered again");
    }

    /// A delete that got the connection first (its tombstone written while
    /// the upsert waits on the lock) must never be overwritten by the queued
    /// upsert's live row. Deterministic: the test writes the tombstone itself
    /// through the held connection, so the upsert always runs second. Red
    /// when the stat and seq are taken before the lock (the upsert saw the
    /// file and writes it back), green when they are taken under it.
    #[test]
    fn an_upsert_queued_behind_a_delete_never_resurrects_the_file() {
        let f = fixture();
        let reg = VaultRegistry::open(&f.app, &f.root);
        let path = put(&f, MB, "7:2,.eml");
        let held = guard(&reg.conn);
        std::thread::scope(|s| {
            let (reg, path) = (&reg, &path);
            s.spawn(move || reg.upsert(ACCT, MB, 7, path));
            // Long enough for an upsert that stats before the lock to have stat'ed.
            std::thread::sleep(std::time::Duration::from_millis(50));
            fs::remove_file(path).unwrap();
            held.as_ref()
                .unwrap()
                .execute(
                    "INSERT INTO files (account_id, vault_dir, uid, filename, size, mtime_ns, seq, light_row) VALUES (?1, ?2, 7, NULL, 0, 0, ?3, NULL)
                     ON CONFLICT (account_id, vault_dir, uid) DO UPDATE SET filename = NULL, light_row = NULL, seq = excluded.seq",
                    params![ACCT, MB, reg.next_seq()],
                )
                .unwrap();
            drop(held);
        });
        let live: Option<Option<String>> = guard(&reg.conn)
            .as_ref()
            .unwrap()
            .query_row("SELECT filename FROM files WHERE uid = 7", [], |r| r.get(0))
            .optional()
            .unwrap();
        assert_eq!(live.flatten(), None, "uid 7 is live with no file on disk");
    }

    #[test]
    fn an_unreadable_cur_is_unknown_and_a_missing_one_is_empty() {
        let f = fixture();
        let reg = VaultRegistry::open(&f.app, &f.root);
        let file_cur = cur(&f, "Broken");
        fs::create_dir_all(file_cur.parent().unwrap()).unwrap();
        fs::write(&file_cur, b"not a dir").unwrap();
        assert_eq!(reg.uid_sets(&f.root, ACCT, "Broken"), None);
        assert_eq!(reg.uid_sets(&f.root, ACCT, "Missing"), Some((vec![], vec![])));
        // A missing vault root (an unmounted drive) is not an empty folder.
        assert_eq!(reg.uid_sets(&f.root.join("gone"), ACCT, "Other"), None);
    }

    #[test]
    fn a_mailbox_is_listed_once_per_session() {
        let f = fixture();
        put(&f, MB, "1:2,.eml");
        let reg = VaultRegistry::open(&f.app, &f.root);
        assert_eq!(saved(&reg, &f, MB), vec![1]);
        assert_eq!(saved(&reg, &f, MB), vec![1]);
        assert_eq!(reg.resolve(&f.root, ACCT, MB, 9), Some(None), "a verified miss is absent, no scan");
        assert_eq!(reg.listing_count(), 1);
    }

    #[test]
    fn a_new_session_reconciles_with_the_disk_and_parses_only_the_new_file() {
        let f = fixture();
        let one = put(&f, MB, "1:2,.eml");
        let two = put(&f, MB, "2:2,.eml");
        put(&f, MB, "3:2,.eml");
        {
            let reg = VaultRegistry::open(&f.app, &f.root);
            assert_eq!(reg.light_rows(&f.root, ACCT, MB, None).unwrap().len(), 3);
            assert_eq!(reg.parse_count(), 3);
        }
        fs::remove_file(&one).unwrap();
        put(&f, MB, "4:2,.eml");
        // fs::rename keeps the mtime: the registry must see a rename, not a new file.
        fs::rename(&two, cur(&f, MB).join("2:2,S.eml")).unwrap();

        let reg = VaultRegistry::open(&f.app, &f.root);
        let rows = reg.light_rows(&f.root, ACCT, MB, None).unwrap();
        let uids: Vec<u64> = rows.iter().map(|r| r["uid"].as_u64().unwrap()).collect();
        assert_eq!(uids, vec![2, 3, 4]);
        assert!(rows[0]["flags"].as_array().unwrap().iter().any(|f| f == "\\Seen"));
        assert_eq!(rows[2]["subject"], "m4");
        assert_eq!(reg.parse_count(), 1, "only the added file parses");
    }

    #[test]
    fn a_write_between_listing_and_apply_survives() {
        let f = fixture();
        put(&f, MB, "1:2,.eml");
        let reg = VaultRegistry::open(&f.app, &f.root);
        let (account, dir) = key(ACCT, MB);
        let listing = reg.list_mailbox(&f.root, &account, &dir).unwrap();
        let nine = put(&f, MB, "9:2,.eml");
        reg.upsert(ACCT, MB, 9, &nine);
        assert!(reg.apply_listing(&account, &dir, listing));
        assert_eq!(saved(&reg, &f, MB), vec![1, 9]);
    }

    #[test]
    fn a_remove_between_listing_and_apply_stays_removed() {
        let f = fixture();
        let three = put(&f, MB, "3:2,.eml");
        put(&f, MB, "4:2,.eml");
        let reg = VaultRegistry::open(&f.app, &f.root);
        let (account, dir) = key(ACCT, MB);
        let listing = reg.list_mailbox(&f.root, &account, &dir).unwrap();
        fs::remove_file(&three).unwrap();
        reg.remove(ACCT, MB, &[3]);
        assert!(reg.apply_listing(&account, &dir, listing));
        assert_eq!(saved(&reg, &f, MB), vec![4]);
        assert_eq!(reg.resolve(&f.root, ACCT, MB, 3), Some(None));
        // The tombstone goes once a later listing shows the file absent.
        reg.invalidate(ACCT, MB);
        assert_eq!(saved(&reg, &f, MB), vec![4]);
        assert_eq!(row_count(&reg, 3), 0);
    }

    #[test]
    fn an_invalidate_between_listing_and_apply_leaves_the_mailbox_unverified() {
        let f = fixture();
        put(&f, MB, "1:2,.eml");
        let reg = VaultRegistry::open(&f.app, &f.root);
        let (account, dir) = key(ACCT, MB);
        let listing = reg.list_mailbox(&f.root, &account, &dir).unwrap();
        reg.invalidate(ACCT, MB);
        assert!(!reg.apply_listing(&account, &dir, listing));
        assert_eq!(reg.listing_count(), 1);
        assert_eq!(saved(&reg, &f, MB), vec![1]);
        assert_eq!(reg.listing_count(), 2, "the next read listed again");
    }

    #[test]
    fn an_invalidate_of_another_mailbox_does_not_fence_this_one() {
        let f = fixture();
        put(&f, MB, "1:2,.eml");
        let reg = VaultRegistry::open(&f.app, &f.root);
        let (account, dir) = key(ACCT, MB);
        let listing = reg.list_mailbox(&f.root, &account, &dir).unwrap();
        reg.invalidate(ACCT, "Other");
        reg.rename(ACCT, "Other", 7, "7:2,S.eml"); // a miss: invalidates Other
        assert!(reg.apply_listing(&account, &dir, listing));
        let listing = reg.list_mailbox(&f.root, &account, &dir).unwrap();
        reg.invalidate_all();
        assert!(!reg.apply_listing(&account, &dir, listing), "invalidate_all fences every mailbox");
    }

    #[test]
    fn a_garbage_db_is_recreated_on_disk_and_a_new_root_wipes_it() {
        let f = fixture();
        fs::write(f.app.join(DB_FILE), b"this is not sqlite at all, not even close").unwrap();
        let path = put(&f, MB, "1:2,.eml");
        {
            let reg = VaultRegistry::open(&f.app, &f.root);
            reg.upsert(ACCT, MB, 1, &path);
        }
        let header = fs::read(f.app.join(DB_FILE)).unwrap();
        assert!(header.starts_with(b"SQLite format 3\0"), "recreated as a real file, not in memory");
        {
            let reg = VaultRegistry::open(&f.app, &f.root);
            assert_eq!(row_count(&reg, 1), 1, "the row persisted across sessions");
        }
        let other_root = f.root.parent().unwrap().join("vault2");
        fs::create_dir_all(&other_root).unwrap();
        let reg = VaultRegistry::open(&f.app, &other_root);
        assert_eq!(row_count(&reg, 1), 0, "another vault root starts empty");
    }

    #[test]
    fn mailboxes_sharing_a_directory_share_rows() {
        let f = fixture();
        put(&f, "A/B", "1:2,.eml");
        let reg = VaultRegistry::open(&f.app, &f.root);
        assert_eq!(saved(&reg, &f, "A/B"), vec![1]);
        let path = put(&f, "A_B", "2:2,.eml");
        reg.upsert(ACCT, "A_B", 2, &path);
        assert_eq!(saved(&reg, &f, "A/B"), vec![1, 2]);
        assert_eq!(saved(&reg, &f, "A_B"), vec![1, 2]);
        assert_eq!(reg.listing_count(), 1);
    }

    #[test]
    fn writes_report_their_scope() {
        let f = fixture();
        let reg = VaultRegistry::open(&f.app, &f.root);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        reg.set_on_change(Box::new(move |s| guard(&sink).push(s)));
        let path = put(&f, "A/B", "1:2,.eml");
        reg.upsert(ACCT, "A/B", 1, &path);
        reg.invalidate_all();
        let mb = Scope::Mailbox { account: ACCT.into(), vault_dir: "A_B".into() };
        assert_eq!(*guard(&seen), vec![mb, Scope::All]);
    }

    #[test]
    fn an_unparseable_file_is_parsed_once_and_left_out() {
        let f = fixture();
        put(&f, MB, "1:2,.eml");
        let dir = cur(&f, MB);
        // mailparse refuses a header block that opens with a space.
        fs::write(dir.join("2:2,.eml"), b" not mail\r\n\r\n").unwrap();
        let reg = VaultRegistry::open(&f.app, &f.root);
        let first = reg.light_rows(&f.root, ACCT, MB, None).unwrap();
        let second = reg.light_rows(&f.root, ACCT, MB, None).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        assert_eq!(reg.parse_count(), 2, "the bad file is not parsed again");
        assert_eq!(saved(&reg, &f, MB), vec![1, 2], "still a saved uid");
    }
}
