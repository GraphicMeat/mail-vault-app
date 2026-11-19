//! The deleted-mail bin on the phone: desktop's bin (core `app_db::deleted`), its rows in the
//! phone's core `app.db` (`<data_dir>/core/app.db`, whose `deleted_messages` table comes with
//! core's schema, so `mobile.db` needs no step) and its kept messages in `<data_dir>/deleted/`.
//! This file is the phone's wiring; the store, the capture rule and the retention are core's.
//!
//! # Capture (in the replay, `actions.rs`)
//!
//! A delete is captured when the replay worker sends it, not when it is tapped: an offline delete
//! is captured when it really runs, and a tap never waits on a download. The backend first says
//! what the delete will do (`Backend::delete_plan`, core's delete rule), and the delete then does
//! exactly that.
//! - A move to Trash is recorded without its bytes (Trash holds it): the list row (subject,
//!   sender, date), its flags, its Message-ID and where Trash is. As on desktop, a message with no
//!   Message-ID is not recorded, since nothing could find it in Trash again.
//! - A permanent delete (in Trash, or Graph's Deleted Items) downloads the whole message first
//!   (`Backend::raw`) and keeps it as `<data_dir>/deleted/<id>.eml`, written durably (fsync)
//!   outside the `app.db` lock. A download that fails for a passing reason is a failure of the
//!   delete: retried with the journal's backoff, never sent without its copy (the desktop refuses
//!   such a delete for the same reason). One the server refuses (or a copy the disk refuses) is a
//!   refusal: counted, and at the limit the delete drops and the message stays on the server, so
//!   it never holds the account's later actions back for good. A retry downloads nothing it kept
//!   already. On a network the phone's background downloads stay off (data saver / Low Data Mode,
//!   or the account's daily cap) the delete waits, queued with `DOWNLOAD_HELD`, and goes when the
//!   network allows downloads again.
//!
//! The bin rows are written (file first, then row) and each named in the journal row (`arg.bin`)
//! as it is made, before anything goes on the wire. A delete that does not happen (dropped, refused for good,
//! cancelled, or its folder gone) takes them back out, except a permanent delete that went on the
//! wire, which may have landed with its reply lost: its copy stays.
//!
//! # Recover (`mobile.deleted.recover`)
//!
//! A journaled `restore` (`arg.binId`, no uids), replayed in the account's order
//! (`actions::run_restore`): never a second copy on the server. With a Message-ID, a folder that
//! holds it already is done. A byte-less row is moved back out of Trash (found by its
//! Message-ID); gone from Trash, the restore drops with `GONE_FROM_TRASH`, which the page shows as
//! `deletedBin.goneFromTrash`. A kept message is uploaded (`Backend::append`: IMAP APPEND with its
//! flags and date, JMAP `Email/import`, Graph a message made from the MIME, which Graph keeps as a
//! draft, as desktop's migration does). The bin row goes once the restore is done. A recover of a
//! row whose delete the journal still owes is refused (`deletedBin.deleteStillQueued`). There is no
//! "recover as a local copy": the phone has no vault.
//!
//! # API
//!
//! - `mobile.deleted.list {after?: {deletedAt, id}, limit?}` -> `{rows: [desktop's deleted.list
//!   row], next: {deletedAt, id} | null}`, newest first, at most `limit` (default and cap
//!   [`PAGE`]). Each list purges one unit of expired rows first, as desktop's does.
//! - `mobile.deleted.recover {ids}` -> `{queued: [{id, seq}], failed: [{id, error}]}`, `error` a
//!   catalog key.
//! - `mobile.deleted.discard {ids}` or `{all: true}` -> `{removed}`: gone for good, file and row.
//!   An id that is not a bin row's is skipped.
//!
//! Retention is desktop's `deletedRetentionDays` (a preference, 1 to 30 days, 1 by default),
//! counted from when the delete landed on the server, and enforced by [`start`]'s sweep: a
//! background thread at background priority that purges [`SWEEP_UNIT`] rows at a time, a minute
//! after launch and then hourly. A row a queued delete or restore still names is never purged. Removing an account
//! removes its rows and files ([`forget_account`]). Nothing is Premium, as on desktop.

use crate::backend::{Backend, DeletePlan, Flags, FolderRow, Header};
use crate::db::{Engine, Shared};
use crate::rpc::{parse, RpcError};
use crate::sync::Fail;
use mailvault_core::app_db::deleted::{self as store, Capture, Deleted};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

/// The journal kind of a recover.
pub(crate) const RESTORE: &str = "restore";
/// Most rows one list answers.
pub(crate) const PAGE: usize = 200;
/// Rows one sweep step purges (one `app.db` lock each).
pub(crate) const SWEEP_UNIT: usize = 50;
/// Most ids one recover or discard names.
const MAX_IDS: usize = 500;
const FIRST_SWEEP: Duration = Duration::from_secs(60);
const SWEEP_EVERY: Duration = Duration::from_secs(3600);

fn internal(e: impl ToString) -> RpcError {
    RpcError::Internal(e.to_string())
}

/// The data dir: the bin's files live in `<data_dir>/deleted`.
fn dir(shared: &Shared) -> Option<PathBuf> {
    shared.data_dir().map(Path::to_path_buf)
}

fn now_ms() -> i64 {
    crate::compose::now_ms()
}

/// The retention preference (`settings.rs`), clamped by core.
fn retention_days(shared: &Shared) -> i64 {
    let stored = shared.read(|c| crate::settings::get_in(c, "deletedRetentionDays")).ok().flatten();
    let days = stored.and_then(|s| s.parse::<i64>().ok());
    store::retention_days(&json!({ "deletedRetentionDays": days }))
}

/// The list row the bin keeps, in desktop's shape (`subject`, `from: {name, address}`, `date`).
struct Local {
    message_id: Option<String>,
    flags: Vec<String>,
    row: Value,
}

/// What the phone holds about `uids` of `folder`: the list row, the flags it shows, the
/// Message-ID.
fn local_rows(shared: &Shared, account: &str, folder: &str, uids: &[u32]) -> Result<HashMap<u32, Local>, Fail> {
    let list = crate::sync::uid_list(uids);
    Ok(shared.read(|c| {
        let mut st = c.prepare(&format!(
            "SELECT uid, subject, from_name, from_address, date_ms, message_id,
                    COALESCE(local_seen, seen), COALESCE(local_flagged, flagged), answered, size
             FROM messages WHERE account_id = ?1 AND folder = ?2 AND uid IN ({list})"
        ))?;
        let rows = st
            .query_map((account, folder), |r| {
                let mut flags = Vec::new();
                for (i, name) in [(6, "\\Seen"), (7, "\\Flagged"), (8, "\\Answered")] {
                    if r.get::<_, i64>(i)? != 0 {
                        flags.push(name.to_string());
                    }
                }
                let mid: String = r.get(5)?;
                Ok((
                    r.get::<_, i64>(0)? as u32,
                    Local {
                        message_id: Some(mid).filter(|m| !m.trim().is_empty()),
                        flags,
                        row: json!({
                            "subject": r.get::<_, String>(1)?,
                            "from": { "name": r.get::<_, String>(2)?, "address": r.get::<_, String>(3)? },
                            "date": r.get::<_, i64>(4)?,
                            "size": r.get::<_, i64>(9)?,
                        }),
                    },
                ))
            })?
            .collect::<Result<HashMap<_, _>, _>>()?;
        Ok(rows)
    })?)
}

/// What [`capture`] came to.
pub(crate) enum Captured {
    /// The bin rows of the delete are made (each named to `record` as it was).
    Ready,
    /// The server (or the disk) refused what the capture needs, not for a passing reason: the
    /// download of a permanent delete answered no, or its copy could not be written. Counted
    /// toward dropping the delete, which then leaves the message on the server.
    Refused(String),
    /// A permanent delete would download on a network the phone's background downloads stay off
    /// (data saver, or the account's daily cap): it waits, queued.
    Held,
}

/// Why a permanent delete waits ([`Captured::Held`]), as the journal row's `last_error`.
pub(crate) const DOWNLOAD_HELD: &str = "DOWNLOAD_HELD";

/// Whether a permanent delete's download waits: the network is constrained (Low Data Mode, data
/// saver) or the account's background download cap is reached, as for every other download the
/// phone makes without the user waiting on it.
fn downloads_held(shared: &Shared, account: &str) -> bool {
    !crate::offline::downloads_allowed(shared) || crate::usage::background_capped(shared, account)
}

/// The bin rows for a delete of `uids` about to be sent with `plan` (see the module): one per
/// message, made now or found from an earlier attempt. Each is named to `record` (the journal row)
/// as soon as it exists, so a later failure never makes an earlier message download again.
///
/// A row is this message's when it has the same place (account, folder, uid) and the same list
/// row, generation (`uidValidity`) included: a uid the server reused for another message after a
/// UIDVALIDITY change never inherits the old message's bytes. A permanent delete whose row holds
/// the bytes already downloads nothing; otherwise it downloads the message (one the server no
/// longer has is skipped: the delete finds it gone too), writes the copy durably outside the
/// `app.db` lock, then the row under it. A move to Trash whose row cannot be written goes ahead
/// without it (logged): the bin is a convenience there, Trash holds the message.
pub(crate) fn capture(
    shared: &Shared,
    backend: &mut dyn Backend,
    account: &str,
    folder: &FolderRow,
    uids: &[u32],
    plan: &DeletePlan,
    record: &mut dyn FnMut(&str) -> Result<(), Fail>,
) -> Result<Captured, Fail> {
    let Some(data) = dir(shared) else {
        return Ok(Captured::Ready);
    };
    let mut local = match local_rows(shared, account, &folder.path, uids) {
        Ok(local) => local,
        Err(Fail::Code(_, why)) if !plan.permanent => {
            shared.log(&format!("[bin] {account}: not recorded (reading the rows: {why})"));
            return Ok(Captured::Ready);
        }
        Err(e) => return Err(e),
    };
    for uid in uids {
        crate::sync::not_closing(shared)?;
        let Local { message_id, flags, mut row } =
            local.remove(uid).unwrap_or(Local { message_id: None, flags: Vec::new(), row: json!({}) });
        row["uidValidity"] = json!(folder.uid_validity);
        let kept = match shared.app_db.with(|c| store::captures_of(c, &data, account, &folder.path, *uid)) {
            Ok(rows) => rows.into_iter().find(|d| d.row == row),
            Err(e) if plan.permanent => return Ok(Captured::Refused(format!("deleted bin: {e}"))),
            Err(e) => {
                shared.log(&format!("[bin] {account}: not recorded: {e}"));
                continue;
            }
        };
        if !plan.permanent {
            let id = match kept {
                Some(d) => d.id,
                // A byte-less row is found again in Trash by its Message-ID only.
                None if message_id.is_none() => continue,
                None => {
                    let id = store::new_id();
                    let c = Capture { account_id: account, mailbox: &folder.path, uid: *uid, message_id: message_id.as_deref(), flags: &flags, row: &row, deleted_at: now_ms() };
                    let made = shared.app_db.with(|conn| {
                        store::insert_captured(conn, &id, &c, false)?;
                        store::set_trash(conn, &id, plan.trash.as_deref(), None)
                    });
                    if let Err(e) = made {
                        shared.log(&format!("[bin] {account}: not recorded: {e}"));
                        continue;
                    }
                    id
                }
            };
            record(&id)?;
            continue;
        }
        let (id, upgrade) = match kept {
            // Kept by an earlier attempt: nothing to download again.
            Some(d) if d.has_eml => {
                record(&d.id)?;
                continue;
            }
            Some(d) => (d.id, true),
            None => (store::new_id(), false),
        };
        if downloads_held(shared, account) {
            return Ok(Captured::Held);
        }
        let raw = match backend.raw(folder, *uid) {
            Ok(Some(raw)) => raw,
            Ok(None) => continue,
            // The server answered no (not the network, the sign-in or a timeout).
            Err(Fail::Code(crate::accounts::Code::Invalid, why)) => return Ok(Captured::Refused(why)),
            Err(f) => return Err(f),
        };
        let message_id = message_id.or_else(|| mailvault_core::maildir::message_id_key(&raw));
        // File first (durable: it must outlive a power loss before the server delete), outside the
        // lock; then the row.
        if let Err(e) = store::write_eml_durable(&data, &id, &raw) {
            return Ok(Captured::Refused(e));
        }
        drop(raw);
        let c = Capture { account_id: account, mailbox: &folder.path, uid: *uid, message_id: message_id.as_deref(), flags: &flags, row: &row, deleted_at: now_ms() };
        if let Err(e) = shared.app_db.with(|conn| store::insert_captured(conn, &id, &c, true)) {
            if !upgrade {
                store::remove_eml(&data, &id);
            }
            return Ok(Captured::Refused(format!("deleted bin: {e}")));
        }
        record(&id)?;
    }
    Ok(Captured::Ready)
}

/// Whether `found` (a message a Message-ID lookup turned up) is the message bin row `row` kept,
/// and not another one carrying the same Message-ID: a Message-ID is the sender's to choose, so
/// anyone can mail one that names a message they know of. The row's own list headers (as the
/// same server listed them before the delete) must all agree: subject, sender address, size, and
/// date (to the second). With the kept bytes, the size and date an upload of them would carry
/// (`raw`'s length and its Date header) count too, so an upload whose reply was lost is found.
/// A row captured without those headers matches nothing: the caller then uploads.
pub(crate) fn same_message(row: &Deleted, raw: Option<&[u8]>, found: &Header) -> bool {
    let r = &row.row;
    let (Some(subject), Some(from), Some(date), Some(size)) =
        (r["subject"].as_str(), r["from"]["address"].as_str(), r["date"].as_i64(), r["size"].as_i64())
    else {
        return false;
    };
    if found.subject != subject || !found.from.address.trim().eq_ignore_ascii_case(from.trim()) {
        return false;
    }
    let found_secs = crate::sync::header_date_ms(found).div_euclid(1000);
    let found_size = i64::from(found.size.unwrap_or(0));
    let uploaded_secs = raw.and_then(|b| mailvault_core::import_rehome::head_of(b).date_secs);
    let date_ok = found_secs == date.div_euclid(1000) || uploaded_secs == Some(found_secs);
    let size_ok = found_size == size || raw.is_some_and(|b| found_size == b.len() as i64);
    date_ok && size_ok
}

/// Takes bin rows (and their files) out: a delete that did not happen.
pub(crate) fn drop_rows(shared: &Shared, ids: &[String]) {
    for id in ids {
        remove(shared, id);
    }
}

/// One bin row and its file, gone; failures are logged.
pub(crate) fn remove(shared: &Shared, id: &str) {
    let Some(data) = dir(shared) else { return };
    if let Err(e) = shared.app_db.with(|c| store::remove(c, &data, id)) {
        shared.log(&format!("[bin] removing a row: {e}"));
    }
}

pub(crate) fn get(shared: &Shared, id: &str) -> Option<Deleted> {
    shared.app_db.with(|c| store::get(c, id)).ok().flatten()
}

/// The kept message of row `id`; `None` when it cannot be read.
pub(crate) fn read_bytes(shared: &Shared, id: &str) -> Option<Vec<u8>> {
    let data = dir(shared)?;
    store::read_eml(&data, id).ok()
}

/// The flags a recovered message goes back with.
pub(crate) fn flags_of(row: &Deleted) -> Flags {
    Flags::of(&row.flags)
}

/// An account removed from the phone takes its bin rows and files with it.
pub(crate) fn forget_account(shared: &Shared, account: &str) {
    sweep_ids(shared, |c| store::ids_of_account(c, Some(account), SWEEP_UNIT));
}

/// Removes, one unit at a time, the rows `next` names until it names none.
fn sweep_ids(shared: &Shared, next: impl Fn(&rusqlite::Connection) -> Result<Vec<String>, String>) {
    let Some(data) = dir(shared) else { return };
    loop {
        let out = shared.app_db.with(|c| {
            let ids = next(c)?;
            for id in &ids {
                store::remove(c, &data, id)?;
            }
            Ok(ids.len())
        });
        match out {
            Ok(0) => return,
            Ok(_) => {}
            Err(e) => {
                shared.log(&format!("[bin] removing rows: {e}"));
                return;
            }
        }
    }
}

/// The bin rows the journal still needs, whatever their age: the captures of a queued delete (it
/// may yet land, and then its copy is the only one) and the row of a queued restore.
fn owed(shared: &Shared) -> Result<Vec<String>, String> {
    shared
        .read(|c| {
        let mut st = c.prepare_cached(
            "SELECT j.value FROM pending_actions p, json_each(p.arg, '$.bin') j WHERE p.kind = 'delete' AND j.type = 'text'
             UNION
             SELECT json_extract(arg, '$.binId') FROM pending_actions WHERE kind = ?1 AND json_extract(arg, '$.binId') IS NOT NULL",
        )?;
        let ids = st.query_map([RESTORE], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
        })
        .map_err(|e| e.to_string())
}

/// A delete landed on the server: its rows count their retention from now, not from the capture
/// (which may be days earlier for a delete that waited offline).
pub(crate) fn landed(shared: &Shared, ids: &[String]) {
    if ids.is_empty() {
        return;
    }
    let at = now_ms();
    if let Err(e) = shared.app_db.with(|c| ids.iter().try_for_each(|id| store::set_deleted_at(c, id, at))) {
        shared.log(&format!("[bin] stamping a landed delete: {e}"));
    }
}

/// One step of the retention sweep: at most [`SWEEP_UNIT`] expired rows, never one the journal
/// still needs ([`owed`]). How many went.
pub(crate) fn purge_step(shared: &Shared) -> usize {
    let Some(data) = dir(shared) else { return 0 };
    let days = retention_days(shared);
    let keep = match owed(shared) {
        Ok(ids) => ids,
        Err(e) => {
            // Not knowing what is owed purges nothing.
            shared.log(&format!("[bin] retention: reading the journal: {e}"));
            return 0;
        }
    };
    match shared.app_db.with(|c| store::purge_expired_some(c, &data, now_ms(), days, SWEEP_UNIT, &keep)) {
        Ok(n) => n,
        Err(e) => {
            shared.log(&format!("[bin] retention: {e}"));
            0
        }
    }
}

/// Every expired row, a unit at a time, yielding between units; stops when the engine closes.
fn sweep(shared: &Shared) {
    while !shared.is_closing() && purge_step(shared) == SWEEP_UNIT {
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The retention sweep's thread (see the module). It holds the engine weakly and ends with it.
pub(crate) fn start(shared: &Arc<Shared>) {
    let weak: Weak<Shared> = Arc::downgrade(shared);
    let spawned = std::thread::Builder::new().name("mv-engine-bin".into()).spawn(move || {
        crate::sync::background_qos();
        let mut wait = FIRST_SWEEP;
        loop {
            let until = Instant::now() + wait;
            while Instant::now() < until {
                match weak.upgrade() {
                    Some(s) if !s.is_closing() => {}
                    _ => return,
                }
                std::thread::sleep(Duration::from_secs(1));
            }
            match weak.upgrade() {
                Some(s) if !s.is_closing() => sweep(&s),
                _ => return,
            }
            wait = SWEEP_EVERY;
        }
    });
    if let Err(e) = spawned {
        shared.log(&format!("[bin] sweep thread: {e}"));
    }
}

// ── RPCs ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct After {
    deleted_at: i64,
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListParams {
    #[serde(default)]
    after: Option<After>,
    #[serde(default)]
    limit: Option<usize>,
}

/// `mobile.deleted.list`; see the module.
pub(crate) fn list(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: ListParams = parse(params)?;
    let shared = engine.shared();
    let Some(data) = dir(shared) else {
        return Ok(json!({ "rows": [], "next": null }));
    };
    purge_step(shared);
    let limit = p.limit.unwrap_or(PAGE).clamp(1, PAGE);
    let rows = shared
        .app_db
        .with(|c| store::list_page(c, &data, p.after.as_ref().map(|a| (a.deleted_at, a.id.as_str())), limit))
        .map_err(internal)?;
    let next = (rows.len() == limit).then(|| rows.last().map(|d| json!({ "deletedAt": d.deleted_at, "id": d.id }))).flatten();
    Ok(json!({ "rows": rows, "next": next }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdsParams {
    #[serde(default)]
    ids: Vec<String>,
    #[serde(default)]
    all: bool,
}

/// What a bin id is: core's `Uuid::new_v4()` text (36 characters, hex digits and dashes).
pub(crate) fn is_bin_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(i, b)| if matches!(i, 8 | 13 | 18 | 23) { b == b'-' } else { b.is_ascii_hexdigit() })
}

fn ids_of(p: &IdsParams) -> Result<(), RpcError> {
    if p.ids.len() > MAX_IDS {
        return Err(RpcError::Invalid(format!("at most {MAX_IDS} ids")));
    }
    Ok(())
}

/// `mobile.deleted.recover {ids}`; see the module.
pub(crate) fn recover(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: IdsParams = parse(params)?;
    ids_of(&p)?;
    if p.all {
        return Err(RpcError::Invalid("recover takes ids".into()));
    }
    let shared = engine.shared();
    let mut queued = Vec::new();
    let mut failed = Vec::new();
    let mut accounts = Vec::new();
    for id in &p.ids {
        let Some(row) = get(shared, id) else {
            failed.push(json!({ "id": id, "error": "deletedBin.recoverFailed" }));
            continue;
        };
        let out = shared
            .write(|c| {
                // The delete that captured it is still owed: it would take the message again.
                let owed: bool = c.query_row(
                    "SELECT EXISTS(SELECT 1 FROM pending_actions p, json_each(p.arg, '$.bin') j WHERE p.kind = 'delete' AND j.value = ?1)",
                    [id],
                    |r| r.get(0),
                )?;
                if owed {
                    return Ok(Err("deletedBin.deleteStillQueued"));
                }
                // One restore per row: a second tap finds the first.
                let already: Option<i64> = c
                    .query_row(
                        "SELECT seq FROM pending_actions WHERE kind = ?1 AND json_extract(arg, '$.binId') = ?2",
                        (RESTORE, id),
                        |r| r.get(0),
                    )
                    .optional()?;
                if let Some(seq) = already {
                    return Ok(Ok(seq));
                }
                let known = c.query_row("SELECT 1 FROM accounts WHERE id = ?1", [&row.account_id], |_| Ok(())).optional()?.is_some();
                if !known {
                    return Ok(Err("deletedBin.recoverFailed"));
                }
                c.execute(
                    "INSERT INTO pending_actions (account_id, folder, uids_json, kind, arg, state, attempts, created_ms)
                     VALUES (?1, ?2, '[]', ?3, ?4, 'queued', 0, ?5)",
                    (&row.account_id, &row.mailbox, RESTORE, json!({ "binId": id }).to_string(), now_ms()),
                )?;
                Ok(Ok(c.last_insert_rowid()))
            })
            .map_err(internal)?;
        match out {
            Ok(seq) => {
                queued.push(json!({ "id": id, "seq": seq }));
                if !accounts.contains(&row.account_id) {
                    accounts.push(row.account_id.clone());
                }
            }
            Err(key) => failed.push(json!({ "id": id, "error": key })),
        }
    }
    for a in &accounts {
        engine.replay().wake(shared, Some(a));
    }
    Ok(json!({ "queued": queued, "failed": failed }))
}

/// `mobile.deleted.discard {ids}` / `{all: true}`; see the module.
pub(crate) fn discard(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: IdsParams = parse(params)?;
    ids_of(&p)?;
    let shared = engine.shared();
    let Some(data) = dir(shared) else {
        return Ok(json!({ "removed": 0 }));
    };
    let mut removed = 0usize;
    if p.all {
        loop {
            let n = shared
                .app_db
                .with(|c| {
                    let ids = store::ids_of_account(c, None, SWEEP_UNIT)?;
                    for id in &ids {
                        store::remove(c, &data, id)?;
                    }
                    Ok(ids.len())
                })
                .map_err(internal)?;
            removed += n;
            if n == 0 {
                break;
            }
        }
    } else {
        // Only a real row's id: an id names a file too, and anything else could name one
        // outside the bin.
        for id in p.ids.iter().filter(|id| is_bin_id(id)) {
            let gone = shared
                .app_db
                .with(|c| {
                    if store::get(c, id)?.is_none() {
                        return Ok(false);
                    }
                    store::remove(c, &data, id)?;
                    Ok(true)
                })
                .map_err(internal)?;
            removed += usize::from(gone);
        }
    }
    Ok(json!({ "removed": removed }))
}
