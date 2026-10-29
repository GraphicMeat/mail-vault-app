//! SQLite-backed mailbox tree and email-header cache.

use crate::vault_flags::FlagChange;
use chrono::DateTime;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

fn err(e: rusqlite::Error) -> String { e.to_string() }

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub(crate) fn sort_ms(row: &Value) -> i64 {
    ["internalDate", "date"].iter()
        .filter_map(|k| row.get(*k).and_then(Value::as_str))
        .find_map(|s| DateTime::parse_from_rfc3339(s).or_else(|_| DateTime::parse_from_rfc2822(s)).ok())
        .map(|d| d.timestamp_millis())
        .unwrap_or(i64::MIN + row.get("uid").and_then(Value::as_i64).unwrap_or(0))
}

pub fn save_headers(conn: &Connection, account: &str, mailbox: &str, data: &str) -> Result<(), String> {
    save_headers_at(conn, account, mailbox, data, now_ms())
}

pub fn save_headers_at(conn: &Connection, account: &str, mailbox: &str, data: &str, written_at: i64) -> Result<(), String> {
    save_headers_reporting_new(conn, account, mailbox, data, written_at).map(|_| ())
}

/// `save_headers_at`, returning the uids that had no row before this write.
pub fn save_headers_reporting_new(conn: &Connection, account: &str, mailbox: &str, data: &str, written_at: i64) -> Result<Vec<u32>, String> {
    let mut added = Vec::new();
    let value: Value = serde_json::from_str(data).map_err(|e| format!("Failed to parse cache JSON: {e}"))?;
    let object = value.as_object().ok_or("cache JSON must be an object")?;
    let tx = conn.unchecked_transaction().map_err(err)?;
    let existing: Option<String> = tx.query_row(
        "SELECT meta_json FROM header_cache_meta WHERE account_id=?1 AND mailbox_path=?2",
        params![account, mailbox], |r| r.get(0),
    ).optional().map_err(err)?;
    let mut meta = match existing {
        Some(text) => serde_json::from_str::<Value>(&text).map_err(|e| format!("stored cache metadata: {e}"))?,
        None => json!({}),
    };
    let rows = object.get("emails").and_then(Value::as_array);
    let decode = |value: Option<&Value>| -> Result<Option<crate::imap::NativeHeaderIdentity>, String> {
        value.filter(|v| !v.is_null()).map(|v| {
            let identity: crate::imap::NativeHeaderIdentity = serde_json::from_value(v.clone()).map_err(|_| "errors.bulkIdentityUncertain")?;
            if identity.account_id != account || identity.mailbox != mailbox || identity.origin_hash.is_empty()
                || identity.uid_validity == Some(0) { return Err("errors.bulkIdentityUncertain".into()); }
            Ok(identity)
        }).transpose()
    };
    let current = decode(meta.get("nativeIdentity"))?;
    let identity = decode(object.get("nativeIdentity"))?;
    if rows.is_none() && identity.is_some() && current.is_some() && current != identity {
        return Err("errors.bulkIdentityChanged".into());
    }
    if rows.is_some() && identity.is_some() && current != identity {
        // A late response must not reinterpret a cache another origin or SELECT
        // generation already owns. Missing expectation is different from observed absence.
        if !object.contains_key("nativeExpectedIdentity") || decode(object.get("nativeExpectedIdentity"))? != current {
            return Err("errors.bulkIdentityChanged".into());
        }
        clear_headers(&tx, Some(account), Some(mailbox))?;
        meta = json!({});
    } else if rows.is_some() && identity.is_none() && object.contains_key("nativeExpectedIdentity")
        && decode(object.get("nativeExpectedIdentity"))? != current {
        return Err("errors.bulkIdentityChanged".into());
    }
    if identity.is_none() && rows.is_some_and(|rows| !rows.is_empty())
        || object.get("nativeIdentity").is_some_and(Value::is_null)
        || object.get("uidValidity").filter(|v| !v.is_null()).is_some_and(|v| current.as_ref().is_some_and(|old| v.as_u64() != old.uid_validity.map(u64::from))) {
        meta.as_object_mut().ok_or("stored cache metadata is not an object")?.remove("nativeIdentity");
    }
    let map = meta.as_object_mut().ok_or("stored cache metadata is not an object")?;
    for (key, val) in object {
        if !matches!(key.as_str(), "emails" | "removedUids" | "accountId" | "mailbox" | "nativeExpectedIdentity") && !val.is_null()
            && (key != "nativeIdentity" || rows.is_some()) {
            map.insert(key.clone(), val.clone());
        }
    }
    if rows.is_some() {
        if let Some(identity) = &identity { map.insert("uidValidity".into(), json!(identity.uid_validity)); }
    }
    let removed = object.get("removedUids").and_then(Value::as_array).filter(|uids| !uids.is_empty());
    // The app's own delete, move or Empty Trash takes rows off the list; the
    // daemon's `syncTotalEmails` (its expunge gate's baseline, written by the
    // daemon alone) stays as it is. The rows this write takes on balance (a
    // re-key removes some uids and adds others) are tallied apart, counting
    // only uids below the daemon's `syncUidNext` (an arrival the app fetched
    // past it was never in the baseline). Only where the daemon keeps a count;
    // the daemon's own write resets the tally (`write_meta`).
    let baseline_below = map.get("syncUidNext").and_then(Value::as_u64).unwrap_or(u64::from(u32::MAX) + 1) as i64;
    let tally = removed.is_some() && map.get("syncTotalEmails").and_then(Value::as_u64).is_some();
    let counted = |tx: &rusqlite::Transaction| -> Result<i64, String> {
        tx.query_row(
            "SELECT count(*) FROM header_cache WHERE account_id=?1 AND mailbox_path=?2 AND uid < ?3",
            params![account, mailbox, baseline_below],
            |r| r.get(0),
        )
        .map_err(err)
    };
    let rows_before = if tally { Some(counted(&tx)?) } else { None };
    if let Some(rows) = object.get("emails").and_then(Value::as_array) {
        let mut stmt = tx.prepare_cached(
            "INSERT OR REPLACE INTO header_cache(account_id,mailbox_path,uid,sort_ms,updated_ms,header_json) VALUES (?1,?2,?3,?4,?5,?6)"
        ).map_err(err)?;
        for row in rows {
            let Some(uid) = row.get("uid").and_then(Value::as_u64).and_then(|u| u32::try_from(u).ok()) else { continue };
            let mut stored_row = row.clone();
            if let Some(row) = stored_row.as_object_mut() { row.remove("_nativeIdentity"); row.remove("_nativeExpectedIdentity"); }
            let json = serde_json::to_string(&stored_row).map_err(|e| e.to_string())?;
            // An unchanged header costs one primary-key read and no index work.
            let stored: Option<String> = tx.query_row(
                "SELECT header_json FROM header_cache WHERE account_id=?1 AND mailbox_path=?2 AND uid=?3",
                params![account, mailbox, uid], |r| r.get(0),
            ).ok();
            stmt.execute(params![account, mailbox, uid, sort_ms(row), written_at, json]).map_err(err)?;
            if stored.is_none() {
                added.push(uid);
            }
            if stored.as_deref() != Some(json.as_str()) {
                crate::people::message_addr::index_row(&tx, account, mailbox, uid, sort_ms(row), row)?;
            }
        }
    }
    if let Some(uids) = removed {
        let mut stmt = tx.prepare_cached("DELETE FROM header_cache WHERE account_id=?1 AND mailbox_path=?2 AND uid=?3").map_err(err)?;
        for uid in uids.iter().filter_map(Value::as_u64) {
            stmt.execute(params![account, mailbox, uid as i64]).map_err(err)?;
            crate::people::message_addr::forget_row(&tx, account, mailbox, uid as u32)?;
        }
    }
    if let Some(before) = rows_before {
        let net_removed = before.saturating_sub(counted(&tx)?) as u64;
        if net_removed > 0 {
            let so_far = map.get(APP_REMOVED_SINCE_SYNC).and_then(Value::as_u64).unwrap_or(0);
            map.insert(APP_REMOVED_SINCE_SYNC.into(), json!(so_far + net_removed));
        }
    }
    tx.execute(
        "INSERT OR REPLACE INTO header_cache_meta(account_id,mailbox_path,meta_json) VALUES (?1,?2,?3)",
        params![account, mailbox, serde_json::to_string(&meta).map_err(|e| e.to_string())?],
    ).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(added)
}

/// Header-cache meta key: rows the app's own writes took off a mailbox's list
/// since the daemon last recorded `syncTotalEmails`. The listing is complete
/// against `syncTotalEmails - appRemovedSinceSync` (`folder_listing`). The
/// daemon's expunge gate never counts with it; the sync reads it only as a
/// reason to list the mailbox when EXISTS did not move with the app's removal
/// (its hole heal), and its `write_meta` resets it to 0.
pub const APP_REMOVED_SINCE_SYNC: &str = "appRemovedSinceSync";

/// How `load_headers` orders the rows it hands back.
///
/// Mirrors `header_cache::load_from_sidecars`, the tree this table replaced.
/// `Arrival` is uid DESC: an IMAP server issues uids in arrival order, so the
/// newest message is the highest uid whatever its Date header says — a
/// migrated copy, an APPEND, or a sender with a skewed clock still reads as
/// the new arrival it is. `Date` is for Graph, whose uid is a listing
/// POSITION and carries no age at all.
///
/// Dropping this distinction is what let a freshly appended message with an
/// old INTERNALDATE sort to the bottom, so "the newest header" — the preview
/// on a new-mail notification — named a message from months ago.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum HeaderOrder {
    Arrival,
    Date,
}

impl HeaderOrder {
    fn clause(self) -> &'static str {
        match self {
            HeaderOrder::Arrival => "uid DESC",
            HeaderOrder::Date => "sort_ms DESC, uid DESC",
        }
    }
}

pub fn load_headers(conn: &Connection, account: &str, mailbox: &str, limit: Option<usize>, order: HeaderOrder) -> Result<Option<String>, String> {
    let meta: Option<String> = conn.query_row(
        "SELECT meta_json FROM header_cache_meta WHERE account_id=?1 AND mailbox_path=?2",
        params![account, mailbox], |r| r.get(0),
    ).optional().map_err(err)?;
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM header_cache WHERE account_id=?1 AND mailbox_path=?2", params![account, mailbox], |r| r.get(0)
    ).map_err(err)?;
    if meta.is_none() && count == 0 { return Ok(None); }
    let mut stmt = conn.prepare(&format!(
        "SELECT header_json FROM header_cache WHERE account_id=?1 AND mailbox_path=?2 ORDER BY {} LIMIT ?3",
        order.clause(),
    )).map_err(err)?;
    let take = limit.map(|n| n as i64).unwrap_or(-1);
    let rows = stmt.query_map(params![account, mailbox, take], |r| r.get::<_, String>(0)).map_err(err)?
        .collect::<Result<Vec<_>, _>>().map_err(err)?;
    let emails = rows.into_iter().filter_map(|s| serde_json::from_str::<Value>(&s).ok()).collect::<Vec<_>>();
    let mut out = match meta { Some(text) => serde_json::from_str::<Value>(&text).map_err(|e| format!("stored cache metadata: {e}"))?, None => json!({}) };
    let map = out.as_object_mut().ok_or("stored cache metadata is not an object")?;
    map.insert("emails".into(), Value::Array(emails));
    map.insert("totalCached".into(), json!(count));
    serde_json::to_string(&out).map(Some).map_err(|e| e.to_string())
}

pub fn load_meta(conn: &Connection, account: &str, mailbox: &str) -> Result<Option<String>, String> {
    // No rows come back at all, so the order is irrelevant here.
    let Some(text) = load_headers(conn, account, mailbox, Some(0), HeaderOrder::Arrival)? else { return Ok(None) };
    let mut value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    value.as_object_mut().map(|m| m.remove("emails"));
    serde_json::to_string(&value).map(Some).map_err(|e| e.to_string())
}

/// Read only the stored native owner, without scanning/counting header rows.
/// Corrupt metadata is unknown, never an observed legacy/absent identity.
pub fn native_identity(conn: &Connection, account: &str, mailbox: &str) -> Result<Option<crate::imap::NativeHeaderIdentity>, String> {
    let text: Option<String> = conn.query_row("SELECT meta_json FROM header_cache_meta WHERE account_id=?1 AND mailbox_path=?2", params![account, mailbox], |r| r.get(0)).optional().map_err(err)?;
    let Some(text) = text else { return Ok(None) };
    let meta: Value = serde_json::from_str(&text).map_err(|_| "errors.bulkIdentityUncertain")?;
    let object = meta.as_object().ok_or("errors.bulkIdentityUncertain")?;
    let Some(identity) = object.get("nativeIdentity").filter(|v| !v.is_null()) else { return Ok(None) };
    let identity: crate::imap::NativeHeaderIdentity = serde_json::from_value(identity.clone()).map_err(|_| "errors.bulkIdentityUncertain")?;
    if identity.account_id != account || identity.mailbox != mailbox || identity.origin_hash.is_empty() || identity.uid_validity == Some(0) {
        return Err("errors.bulkIdentityUncertain".into());
    }
    Ok(Some(identity))
}

/// Predicate fields for an unread recount. One bounded custody hold reads one
/// page, and no subject, address, body or full header leaves this query.
pub fn unread_rows_page(conn: &Connection, account: &str, mailbox: &str, after_uid: u32,
    limit: usize) -> Result<Vec<Value>, String> {
    let mut stmt = conn.prepare(
        "SELECT uid, CASE WHEN json_type(header_json,'$.flags')='array' THEN json_extract(header_json,'$.flags') END, \
         json_extract(header_json,'$.messageId'), json_extract(header_json,'$._accountId'), \
         json_extract(header_json,'$._srcAccountId'), json_extract(header_json,'$._mailbox'), \
         CASE WHEN json_type(header_json,'$.isArchived') IN ('true','false') \
              THEN json_extract(header_json,'$.isArchived') END \
         FROM header_cache WHERE account_id=?1 AND mailbox_path=?2 AND uid>?3 \
         AND json_valid(header_json) ORDER BY uid ASC LIMIT ?4"
    ).map_err(err)?;
    let rows = stmt.query_map(params![account, mailbox, after_uid, limit as i64], |r| {
        let uid: u32 = r.get(0)?;
        let flags: Option<String> = r.get(1)?;
        let message_id: Option<String> = r.get(2)?;
        let row_account: Option<String> = r.get(3)?;
        let source_account: Option<String> = r.get(4)?;
        let row_mailbox: Option<String> = r.get(5)?;
        let archived: Option<i64> = r.get(6)?;
        let mut value = json!({"uid":uid});
        if let Some(flags) = flags.and_then(|s| serde_json::from_str::<Value>(&s).ok()) { value["flags"] = flags; }
        if let Some(v) = message_id { value["messageId"] = json!(v); }
        if let Some(v) = row_account { value["_accountId"] = json!(v); }
        if let Some(v) = source_account { value["_srcAccountId"] = json!(v); }
        if let Some(v) = row_mailbox { value["_mailbox"] = json!(v); }
        if let Some(v) = archived { value["isArchived"] = json!(v != 0); }
        Ok(value)
    }).map_err(err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(err)
}

/// Uids per `IN (...)`: under SQLITE_MAX_VARIABLE_NUMBER on every build
/// (999 before SQLite 3.32), with the two scope parameters on top.
const UID_CHUNK: usize = 900;

/// The cached headers of `uids`, newest first (`sort_ms DESC, uid DESC`, the
/// same order as `load_headers`). Queried in chunks: one `IN (...)` holding
/// every uid fails past SQLite's bound-parameter limit.
pub fn load_by_uids(conn: &Connection, account: &str, mailbox: &str, uids: &[u32]) -> Result<Vec<Value>, String> {
    // Deduplicated so a uid repeated across two chunks is not returned twice
    // (a single `IN` matched it once).
    let mut wanted = uids.to_vec();
    wanted.sort_unstable();
    wanted.dedup();
    let mut rows: Vec<(i64, u32, String)> = Vec::new();
    for chunk in wanted.chunks(UID_CHUNK) {
        let marks = std::iter::repeat_n("?", chunk.len()).collect::<Vec<_>>().join(",");
        let sql = format!("SELECT sort_ms, uid, header_json FROM header_cache WHERE account_id=? AND mailbox_path=? AND uid IN ({marks})");
        let mut args: Vec<rusqlite::types::Value> = vec![account.to_string().into(), mailbox.to_string().into()];
        args.extend(chunk.iter().map(|u| i64::from(*u).into()));
        let mut stmt = conn.prepare_cached(&sql).map_err(err)?;
        let found = stmt.query_map(params_from_iter(args), |r| Ok((r.get::<_, i64>(0)?, r.get::<_, u32>(1)?, r.get::<_, String>(2)?))).map_err(err)?;
        for row in found { rows.push(row.map_err(err)?); }
    }
    rows.sort_unstable_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    Ok(rows.into_iter().filter_map(|(_, _, s)| serde_json::from_str(&s).ok()).collect())
}

/// Exactly one current cached UID for a persisted Message-ID. A local
/// snooze's stored UID is only a hint: the server may have reissued it while
/// the message itself is still named by Message-ID. Read at most two UIDs to
/// detect ambiguity and never bring a whole header list into the caller.
pub fn unique_uid_by_message_id(conn: &Connection, account: &str, mailbox: &str,
    message_id: &str) -> Result<Option<u32>, String> {
    let Some(key) = message_id_key(message_id) else { return Ok(None) };
    let mut statement = conn.prepare(
        "SELECT uid FROM header_cache WHERE account_id=?1 AND mailbox_path=?2 \
         AND CASE WHEN json_valid(header_json) THEN \
         trim(json_extract(header_json,'$.messageId'), '<> ') END=?3 LIMIT 2"
    ).map_err(err)?;
    let rows = statement.query_map(params![account, mailbox, key], |row| row.get::<_, u32>(0))
        .map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?;
    if rows.len() > 1 { return Err("ambiguous-message".to_owned()); }
    Ok(rows.first().copied())
}

/// `(uid, flags)` of each cached uid in `uids`, ascending by uid: the lean
/// read for a caller that needs no more of a header than whether it is
/// listed and its flags. Only the `flags` member is pulled out of each row
/// (no whole-header parse); a row whose JSON does not parse is not listed,
/// as `load_by_uids` drops it, and a header without flags has none. Chunked
/// like `load_by_uids`.
pub fn flags_by_uids(conn: &Connection, account: &str, mailbox: &str, uids: &[u32]) -> Result<Vec<(u32, Vec<String>)>, String> {
    let mut wanted = uids.to_vec();
    wanted.sort_unstable();
    wanted.dedup();
    let mut rows: Vec<(u32, Vec<String>)> = Vec::with_capacity(wanted.len());
    for chunk in wanted.chunks(UID_CHUNK) {
        let marks = std::iter::repeat_n("?", chunk.len()).collect::<Vec<_>>().join(",");
        // `json_valid` in the WHERE, so the select list never sees a
        // malformed row: `json_extract` on one fails the whole statement.
        let sql = format!(
            "SELECT uid, CASE WHEN json_type(header_json, '$.flags') = 'array' THEN json_extract(header_json, '$.flags') END \
             FROM header_cache WHERE account_id=? AND mailbox_path=? AND uid IN ({marks}) AND json_valid(header_json)"
        );
        let mut args: Vec<rusqlite::types::Value> = vec![account.to_string().into(), mailbox.to_string().into()];
        args.extend(chunk.iter().map(|u| i64::from(*u).into()));
        let mut stmt = conn.prepare_cached(&sql).map_err(err)?;
        let found = stmt
            .query_map(params_from_iter(args), |r| Ok((r.get::<_, u32>(0)?, r.get::<_, Option<String>>(1)?)))
            .map_err(err)?;
        for row in found {
            let (uid, flags) = row.map_err(err)?;
            let flags: Vec<String> = flags
                .and_then(|text| serde_json::from_str::<Vec<Value>>(&text).ok())
                .unwrap_or_default()
                .into_iter()
                .filter_map(|flag| flag.as_str().map(str::to_owned))
                .collect();
            rows.push((uid, flags));
        }
    }
    rows.sort_unstable_by_key(|(uid, _)| *uid);
    Ok(rows)
}

/// A cached header's read state as the server holds it (sync keeps it current;
/// a vault file's name keeps the state the file was stored with), and the
/// Message-ID that says which message the row is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadState {
    pub seen: bool,
    /// Normalized (`message_id_key`); `None` when the header carries none.
    pub message_id: Option<String>,
}

impl ReadState {
    /// Whether this row speaks for a vault message with `message_id`. A uid
    /// alone is weak proof: a UIDVALIDITY reissue or a recreated mailbox gives
    /// the number to another message. A side with no Message-ID cannot
    /// contradict the other.
    pub fn applies_to(&self, message_id: Option<&str>) -> bool {
        match (&self.message_id, message_id.and_then(message_id_key)) {
            (Some(ours), Some(theirs)) => *ours == theirs,
            _ => true,
        }
    }
}

/// A Message-ID as the search index compares it, the same trim on both sides
/// (`query::MSG_KEY_SQL`'s `trim(x, '<> ')`): without angle brackets or spaces
/// at either end, `None` when nothing is left.
pub fn message_id_key(id: &str) -> Option<String> {
    let key = id.trim_matches(['<', '>', ' ']);
    (!key.is_empty()).then(|| key.to_string())
}

/// The most header rows one custody hold reads for the search's read state.
pub const READ_STATE_UNIT: usize = UID_CHUNK;

/// The server paths the header cache holds rows for, by the vault folder each
/// is filed under (`vault_dir_name`). Read once per account and passed to the
/// readers below, which each take the paths of one folder.
pub fn vault_folders(conn: &Connection, account: &str) -> Result<HashMap<String, Vec<String>>, String> {
    let mut folders: HashMap<String, Vec<String>> = HashMap::new();
    for (_, mailbox) in mailboxes_with_headers(conn, Some(account))? {
        folders.entry(crate::search_index::text::vault_dir_name(&mailbox)).or_default().push(mailbox);
    }
    Ok(folders)
}

/// Keeps a uid's state, or nothing when two server paths that spell one vault
/// folder disagree on it.
fn keep_read_state(states: &mut HashMap<u32, Option<ReadState>>, uid: u32, state: ReadState) {
    match states.entry(uid) {
        std::collections::hash_map::Entry::Vacant(slot) => {
            slot.insert(Some(state));
        }
        std::collections::hash_map::Entry::Occupied(mut slot) => {
            if slot.get().as_ref() != Some(&state) {
                slot.insert(None);
            }
        }
    }
}

/// `uid`'s read state in each of `mailboxes` (the server paths of one vault
/// folder) for the uids the `WHERE` tail picks. `json_valid` in the WHERE, so
/// the select list never sees a malformed row.
fn read_rows(conn: &Connection, account: &str, mailboxes: &[String], tail: &str, extra: Vec<rusqlite::types::Value>, states: &mut HashMap<u32, Option<ReadState>>) -> Result<(), String> {
    let marks = std::iter::repeat_n("?", mailboxes.len()).collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT uid, EXISTS(SELECT 1 FROM json_each(header_json, '$.flags') WHERE lower(value) = '\\seen'), \
         CASE WHEN json_type(header_json, '$.messageId') = 'text' THEN json_extract(header_json, '$.messageId') END \
         FROM header_cache WHERE account_id=? AND mailbox_path IN ({marks}) AND json_valid(header_json) {tail}"
    );
    let mut args: Vec<rusqlite::types::Value> = vec![account.to_string().into()];
    args.extend(mailboxes.iter().map(|m| rusqlite::types::Value::from(m.clone())));
    args.extend(extra);
    let mut stmt = conn.prepare_cached(&sql).map_err(err)?;
    let rows = stmt
        .query_map(params_from_iter(args), |r| Ok((r.get::<_, u32>(0)?, r.get::<_, bool>(1)?, r.get::<_, Option<String>>(2)?)))
        .map_err(err)?;
    for row in rows {
        let (uid, seen, id) = row.map_err(err)?;
        keep_read_state(states, uid, ReadState { seen, message_id: id.as_deref().and_then(message_id_key) });
    }
    Ok(())
}

fn settled(states: HashMap<u32, Option<ReadState>>) -> HashMap<u32, ReadState> {
    states.into_iter().filter_map(|(uid, state)| state.map(|state| (uid, state))).collect()
}

/// One unit of the read state of a vault folder's cached headers: the uids
/// above `after`, at most `READ_STATE_UNIT` of them, and the cursor for the next
/// unit (`None` once the folder is read out). `mailboxes` are the folder's
/// server paths (`vault_folders`). The one rule for the search filter, the
/// result rows and the scan lane. A row whose JSON does not parse says nothing,
/// and so does a uid two server paths disagree on. A caller takes the custody
/// lock per unit, so a mark-read or a sync write waits for 900 rows at most.
pub fn read_states_after(conn: &Connection, account: &str, mailboxes: &[String], after: u32) -> Result<(HashMap<u32, ReadState>, Option<u32>), String> {
    if mailboxes.is_empty() {
        return Ok((HashMap::new(), None));
    }
    let marks = std::iter::repeat_n("?", mailboxes.len()).collect::<Vec<_>>().join(",");
    let sql = format!("SELECT uid FROM header_cache WHERE account_id=? AND mailbox_path IN ({marks}) AND uid > ? GROUP BY uid ORDER BY uid LIMIT {}", READ_STATE_UNIT + 1);
    let mut args: Vec<rusqlite::types::Value> = vec![account.to_string().into()];
    args.extend(mailboxes.iter().map(|m| rusqlite::types::Value::from(m.clone())));
    args.push(i64::from(after).into());
    let mut stmt = conn.prepare_cached(&sql).map_err(err)?;
    let uids = stmt
        .query_map(params_from_iter(args), |r| r.get::<_, u32>(0))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    let (unit, next) = match uids.get(READ_STATE_UNIT) {
        Some(_) => (&uids[..READ_STATE_UNIT], Some(uids[READ_STATE_UNIT - 1])),
        None => (&uids[..], None),
    };
    let Some(&last) = unit.last() else { return Ok((HashMap::new(), None)) };
    let mut states = HashMap::new();
    read_rows(conn, account, mailboxes, "AND uid > ? AND uid <= ?", vec![i64::from(after).into(), i64::from(last).into()], &mut states)?;
    Ok((settled(states), next))
}

/// The read state of the cached headers of `uids` (at most `READ_STATE_UNIT`;
/// the caller takes the lock per unit) in the vault folder whose server paths
/// are `mailboxes`; same rule as `read_states_after`.
pub fn read_states_of(conn: &Connection, account: &str, mailboxes: &[String], uids: &[u32]) -> Result<HashMap<u32, ReadState>, String> {
    if mailboxes.is_empty() || uids.is_empty() {
        return Ok(HashMap::new());
    }
    debug_assert!(uids.len() <= READ_STATE_UNIT);
    let marks = std::iter::repeat_n("?", uids.len()).collect::<Vec<_>>().join(",");
    let mut states = HashMap::new();
    read_rows(conn, account, mailboxes, &format!("AND uid IN ({marks})"), uids.iter().map(|u| i64::from(*u).into()).collect(), &mut states)?;
    Ok(settled(states))
}

pub fn list_uids(conn: &Connection, account: &str, mailbox: &str, since_ms: Option<f64>) -> Result<Value, String> {
    let mut stmt = conn.prepare("SELECT uid,updated_ms FROM header_cache WHERE account_id=?1 AND mailbox_path=?2 ORDER BY uid").map_err(err)?;
    let rows = stmt.query_map(params![account, mailbox], |r| Ok((r.get::<_, u32>(0)?, r.get::<_, i64>(1)?))).map_err(err)?
        .collect::<Result<Vec<_>, _>>().map_err(err)?;
    let uids = rows.iter().map(|(uid, _)| *uid).collect::<Vec<_>>();
    let changed: Vec<u32> = since_ms.map(|since| rows.iter().filter(|(_, at)| *at as f64 > since).map(|(uid, _)| *uid).collect()).unwrap_or_default();
    Ok(json!({"uids":uids,"changed":changed}))
}

/// Whole-mailbox month histogram for the list date scrubber
/// (`docs/superpowers/specs/2026-09-22-list-date-scrubber-design.md` §1):
/// `[{"ym":"2021-03","count":412}, ...]`, newest first, UTC months. Rows with
/// `sort_ms <= 0` (unknown date — `save_headers_at`'s `sort_ms` falls back to
/// a negative sentinel when neither `internalDate` nor `date` parses) are
/// excluded rather than bucketed under some sentinel month.
pub fn month_histogram(conn: &Connection, account: &str, mailbox: &str) -> Result<Value, String> {
    let mut stmt = conn.prepare(
        "SELECT strftime('%Y-%m', sort_ms/1000, 'unixepoch') AS ym, COUNT(*) FROM header_cache \
         WHERE account_id=?1 AND mailbox_path=?2 AND sort_ms > 0 GROUP BY ym ORDER BY ym DESC"
    ).map_err(err)?;
    let rows = stmt.query_map(params![account, mailbox], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).map_err(err)?
        .collect::<Result<Vec<_>, _>>().map_err(err)?;
    Ok(Value::Array(rows.into_iter().map(|(ym, count)| json!({"ym": ym, "count": count})).collect()))
}

/// "... +0300 (EEST)" -> "... +0300": clients append the zone's name as a
/// comment, and neither the offset read nor chrono's parser wants it.
fn without_trailing_comment(date: &str) -> &str {
    let s = date.trim();
    match s.rfind('(') {
        Some(i) if s.ends_with(')') => s[..i].trim_end(),
        _ => s,
    }
}

/// The numeric zone closing an RFC 2822 Date header, in minutes east of UTC.
/// `None` for `+0000`/`-0000` as well as for anything that is not one: RFC
/// 5322 makes `-0000` "zone unknown", and servers such as Exchange rewrite
/// every Date to `+0000`, so a zero says nothing about where the sender is.
/// ISO strings (a Graph row's `date`) and obsolete names like `GMT` are not
/// read either.
fn date_offset_minutes(date: &str) -> Option<i32> {
    let zone = without_trailing_comment(date).rsplit(char::is_whitespace).next()?;
    let (sign, digits) = match zone.as_bytes().first()? {
        b'+' => (1, &zone[1..]),
        b'-' => (-1, &zone[1..]),
        _ => return None,
    };
    if digits.len() != 4 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let (hours, minutes): (i32, i32) = (digits[..2].parse().ok()?, digits[2..].parse().ok()?);
    if hours > 14 || minutes > 59 || hours + minutes == 0 {
        return None;
    }
    Some(sign * (hours * 60 + minutes))
}

/// What the newest cached message FROM `address` (any account, any mailbox,
/// case-insensitive) says about the sender's clock: its Date header's UTC
/// offset, and the instant that header names, so the caller can check a
/// zone's offset in the right season. `sort_ms` stands in for the instant
/// only when the header will not parse: it prefers INTERNALDATE, which for
/// imported or appended mail can be months away from when it was written.
///
/// `messageDate` before `date`: an IMAP row carries the raw Date header in
/// both, but a Graph row's `date` is the ISO receive time and only its
/// `messageDate` is what the sender's client wrote.
///
/// ponytail: a full scan of `header_cache`, under the one custody connection
/// every sync write also waits on; the LIKE only spares the JSON parse of
/// rows that cannot match. Add an indexed from-address column when a large
/// vault makes this show.
pub fn sender_clock(conn: &Connection, address: &str) -> Result<Option<(i32, Option<i64>)>, String> {
    use rusqlite::OptionalExtension;
    let newest: Option<(Option<String>, i64)> = conn
        .query_row(
            "SELECT COALESCE(json_extract(header_json, '$.messageDate'), json_extract(header_json, '$.date')), sort_ms
             FROM header_cache
             WHERE header_json LIKE '%' || ?1 || '%'
               AND lower(json_extract(header_json, '$.from.address')) = lower(?1)
             ORDER BY sort_ms DESC, uid DESC LIMIT 1",
            [address],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(err)?;
    let Some((Some(date), sort_ms)) = newest else { return Ok(None) };
    let Some(offset) = date_offset_minutes(&date) else { return Ok(None) };
    let at = DateTime::parse_from_rfc2822(without_trailing_comment(&date))
        .map(|d| d.timestamp_millis())
        .ok()
        .or((sort_ms > 0).then_some(sort_ms));
    Ok(Some((offset, at)))
}

/// Subject openings of automatic replies, for the follow-up check's cache
/// scan: the cache keeps no Auto-Submitted for mail it fetched before
/// `autoReply` existed, and some servers send a vacation notice without one.
/// Outlook's and Exchange's forms in the app's nine languages, and the common
/// server ones. Compared case-insensitively against the subject's start.
pub const AUTO_REPLY_SUBJECT_PREFIXES: &[&str] = &[
    // English
    "Automatic reply:", "Auto reply:", "Auto-reply:", "Autoreply:", "Auto:", "Out of Office", "Out of office:",
    // German
    "Automatische Antwort:", "Abwesenheitsnotiz", "Abwesend:",
    // French
    "Réponse automatique", "Absence du bureau",
    // Spanish
    "Respuesta automática:", "Fuera de la oficina",
    // Italian
    "Risposta automatica:", "Fuori sede",
    // Portuguese (Brazil)
    "Resposta automática:", "Ausente do escritório",
    // Japanese
    "自動応答", "自動返信",
    // Korean
    "자동 회신", "자동 응답",
    // Chinese (Simplified, and the Traditional form Outlook also sends)
    "自动回复", "自動回覆",
];

/// Does `subject` open like an automatic reply (`AUTO_REPLY_SUBJECT_PREFIXES`)?
pub fn is_auto_reply_subject(subject: &str) -> bool {
    let subject = subject.trim_start().to_lowercase();
    AUTO_REPLY_SUBJECT_PREFIXES.iter().any(|p| subject.starts_with(&p.to_lowercase()))
}

/// A Message-ID as the reply check compares it: no brackets, no case (IMAP's
/// SEARCH and the LIKE prefilter ignore case too).
fn reply_id(raw: &str) -> String {
    crate::maildir::normalize_message_id(raw).to_lowercase()
}

/// Is the cached `header` someone's answer to the message `id` (`reply_id`):
/// its In-Reply-To or a References entry names it, it is from none of `own`
/// (`notes_to_self::normalize_identity`, the app's `normalizeEmailIdentity`:
/// any case, and a Gmail address however it is dotted or +tagged), and
/// neither its `autoReply` mark nor its subject says a machine sent it. The
/// subject is checked on every row: some servers send a vacation notice with
/// no header to say so.
fn answers(header: &Value, id: &str, own: &[String]) -> bool {
    let names_it = |v: &Value| -> bool {
        let ids: Vec<&str> = match v {
            Value::String(s) => s.split_whitespace().collect(),
            Value::Array(items) => items.iter().filter_map(Value::as_str).flat_map(str::split_whitespace).collect(),
            _ => Vec::new(),
        };
        ids.iter().any(|candidate| reply_id(candidate) == id)
    };
    if !(header.get("inReplyTo").is_some_and(names_it) || header.get("references").is_some_and(names_it)) {
        return false;
    }
    let from = crate::notes_to_self::normalize_identity(header.pointer("/from/address").and_then(Value::as_str).unwrap_or(""));
    if own.iter().any(|o| crate::notes_to_self::normalize_identity(o) == from) {
        return false;
    }
    if header.get("autoReply").and_then(Value::as_str).is_some_and(|v| !v.is_empty()) {
        return false;
    }
    !is_auto_reply_subject(header.get("subject").and_then(Value::as_str).unwrap_or(""))
}

/// One message the follow-up check asks the cache about: `key` names it to
/// the caller (the reminder's id), `own` are the addresses its sender used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplyWanted {
    pub key: String,
    pub message_id: String,
    pub own: Vec<String>,
}

/// One page of `reply_scan_page_many`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplyScan {
    /// The `key`s of the messages a row of this page answers.
    pub replied: Vec<String>,
    /// Where the next page starts (the last uid read), `None` at the end.
    pub next_after: Option<u32>,
}

/// One bounded unit of the follow-up check's header cache scan: the next
/// `limit` cached rows of one folder after `after_uid`, in uid order, and
/// which of `wanted` they answer (`answers`). One read serves every reminder
/// of the account a pass checks. A caller walks a folder page by page and
/// lets the custody lock go between pages, so a foreground read never waits
/// behind a whole folder.
///
/// A row is read whether it matches or not, which is what bounds the page;
/// a substring test of the lowercased JSON (the LIKE prefilter of a one-id
/// scan, done here for several ids at once) spares the parse of rows that
/// name none of them.
pub fn reply_scan_page_many(
    conn: &Connection,
    account: &str,
    mailbox: &str,
    wanted: &[ReplyWanted],
    after_uid: u32,
    limit: u32,
) -> Result<ReplyScan, String> {
    let ids: Vec<String> = wanted.iter().map(|w| reply_id(&w.message_id)).collect();
    let mut stmt = conn
        .prepare_cached(
            "SELECT uid, header_json FROM header_cache WHERE account_id = ?1 AND mailbox_path = ?2 AND uid > ?3
             ORDER BY uid LIMIT ?4",
        )
        .map_err(err)?;
    let mut rows = stmt.query(params![account, mailbox, after_uid, limit]).map_err(err)?;
    let (mut read, mut last) = (0u32, after_uid);
    let mut replied: Vec<String> = Vec::new();
    while let Some(row) = rows.next().map_err(err)? {
        read += 1;
        last = row.get(0).map_err(err)?;
        let json: String = row.get(1).map_err(err)?;
        let lower = json.to_lowercase();
        let named: Vec<usize> = (0..wanted.len())
            .filter(|&i| !ids[i].is_empty() && !replied.contains(&wanted[i].key) && lower.contains(&ids[i]))
            .collect();
        if named.is_empty() {
            continue;
        }
        let Ok(header) = serde_json::from_str::<Value>(&json) else { continue };
        for i in named {
            if answers(&header, &ids[i], &wanted[i].own) {
                replied.push(wanted[i].key.clone());
            }
        }
    }
    Ok(ReplyScan { replied, next_after: (read == limit).then_some(last) })
}

/// How many headers this mailbox has cached. Replaces counting `<uid>.json`
/// files in the sidecar directory — which also had to exclude `_meta.json`
/// and the Outlook uid ledger that still live there.
pub fn count(conn: &Connection, account: &str, mailbox: &str) -> Result<usize, String> {
    conn.query_row(
        "SELECT count(*) FROM header_cache WHERE account_id=?1 AND mailbox_path=?2",
        params![account, mailbox],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n as usize)
    .map_err(err)
}

/// Every uid this mailbox has cached. Replaces listing the sidecar directory.
pub fn uid_set(conn: &Connection, account: &str, mailbox: &str) -> Result<HashSet<u32>, String> {
    let mut stmt = conn
        .prepare("SELECT uid FROM header_cache WHERE account_id=?1 AND mailbox_path=?2")
        .map_err(err)?;
    let rows = stmt
        .query_map(params![account, mailbox], |r| r.get::<_, u32>(0))
        .map_err(err)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(err)?;
    Ok(rows)
}

/// Which of `uids` the server listing (as last synced) still holds in the
/// vault folder `vault_dir`, each with the Message-ID its header carries
/// (`None` when it has none or the row will not parse). The search index asks
/// this to keep an evicted message searchable while the server has it.
///
/// The header cache is keyed by mailbox path and the vault by
/// `vault_dir_name(path)`, which does not invert, so every cached mailbox of
/// the account whose folder name matches answers.
///
/// A listing that cannot prove a uid is gone is `Err` starting with
/// `FOLDER_NOT_LISTED` (`folder_listing`): no mailbox with a row (never
/// synced, cleared, an account's cache wiped), or a mailbox holding fewer rows
/// than the server's count the daemon recorded (a refill or backfill part way:
/// it lands newest first, and evicted mail is old). Reading either as "the
/// server holds none of them" would take evicted mail out of search and its
/// tags with it. A folder the server counts empty lists nothing (`Ok`).
///
/// ponytail: `mailboxes_with_headers` walks the account's key range once per
/// call, and every mailbox's rows are counted; the index asks only when a
/// folder has files gone, but a `vault_dir` column would make this one lookup
/// if large vaults show it.
pub fn listed_message_ids(conn: &Connection, account: &str, vault_dir: &str, uids: &[u32]) -> Result<HashMap<u32, Option<String>>, String> {
    let mut out = HashMap::new();
    if uids.is_empty() {
        return Ok(out);
    }
    let mailboxes = folder_listing(conn, account, vault_dir)?.readable(account, vault_dir)?;
    for chunk in uids.chunks(UID_CHUNK) {
        listed_chunk(conn, account, &mailboxes, chunk, &mut out)?;
    }
    Ok(out)
}

/// `listed_message_ids` against the shared custody store, taking its lock per
/// chunk rather than across the whole lookup: a folder that is mostly evicted
/// asks for thousands of uids on every sweep, and sync writes wait on the same
/// lock. Each chunk judges the folder's listing again under its lock; a store
/// that is not open, or a listing that changed between two chunks (a clear, a
/// refill page, a new count), fails the whole lookup: the chunks already read
/// are never taken as the full answer.
pub fn listed_message_ids_shared(
    db: &crate::custody::SharedConn,
    account: &str,
    vault_dir: &str,
    uids: &[u32],
) -> Result<HashMap<u32, Option<String>>, String> {
    let mut out = HashMap::new();
    if uids.is_empty() {
        return Ok(out);
    }
    let closed = || "custody store is not open".to_string();
    let first = folder_listing(crate::custody::lock(db).as_ref().ok_or_else(closed)?, account, vault_dir)?;
    let mailboxes = first.clone().readable(account, vault_dir)?;
    for chunk in uids.chunks(UID_CHUNK) {
        let guard = crate::custody::lock(db);
        let conn = guard.as_ref().ok_or_else(closed)?;
        if folder_listing(conn, account, vault_dir)? != first {
            return Err(format!("{FOLDER_NOT_LISTED}: {account}/{vault_dir} changed during the lookup"));
        }
        listed_chunk(conn, account, &mailboxes, chunk, &mut out)?;
    }
    Ok(out)
}

/// Whether the cached rows of `mailbox` are all the server held when a SELECT
/// just now answered `uid_validity` / `uid_next`: the daemon's sync recorded
/// that very generation and UIDNEXT (nothing arrived since) and every row its
/// count covers is here (`folder_listing`). Only then does a message the rows
/// lack prove absent from the server. A cache the app wrote (no daemon count),
/// one synced before the latest arrival, or one part way through a refill is
/// never whole.
pub fn lists_whole_mailbox(conn: &Connection, account: &str, mailbox: &str, uid_validity: u32, uid_next: u32) -> Result<bool, String> {
    let Some(meta) = load_meta(conn, account, mailbox)? else { return Ok(false) };
    let meta: Value = serde_json::from_str(&meta).map_err(|e| e.to_string())?;
    let n = |key: &str| meta.get(key).and_then(Value::as_u64);
    if n("uidValidity") != Some(u64::from(uid_validity)) || n("syncUidNext") != Some(u64::from(uid_next)) || n("syncTotalEmails").is_none() {
        return Ok(false);
    }
    Ok(matches!(folder_listing(conn, account, &crate::search_index::text::vault_dir_name(mailbox))?, FolderListing::Complete(_)))
}

/// How a lookup for a folder the header cache holds no complete listing of
/// starts its `Err`.
pub const FOLDER_NOT_LISTED: &str = "the header cache holds no complete listing of this folder";

/// What the header cache can prove about one vault folder.
#[derive(Clone, PartialEq, Eq, Debug)]
enum FolderListing {
    /// The mailboxes to read, each holding rows and at least the count the
    /// daemon last recorded for it. Empty: the server counts the folder empty.
    Complete(Vec<String>),
    /// No mailbox with a row and none the server counts empty.
    Unknown,
    /// A mailbox holding fewer rows than the server's recorded count.
    Partial(String),
}

impl FolderListing {
    /// The mailboxes of a complete listing; anything else is the lookup's `Err`.
    fn readable(self, account: &str, vault_dir: &str) -> Result<Vec<String>, String> {
        match self {
            FolderListing::Complete(mailboxes) => Ok(mailboxes),
            FolderListing::Unknown => Err(format!("{FOLDER_NOT_LISTED}: {account}/{vault_dir} has no header row")),
            FolderListing::Partial(why) => Err(format!("{FOLDER_NOT_LISTED}: {account}/{vault_dir}: {why}")),
        }
    }
}

/// Judge every mailbox behind `vault_dir` (rows or meta) by its row count
/// against `syncTotalEmails` (the server's count only the daemon's sync
/// writes, and `clear_headers` deletes with the rows) less
/// `APP_REMOVED_SINCE_SYNC` (what the app's own deletes and moves took off
/// since). Only rows below the daemon's `syncUidNext` are judged, when it is
/// recorded: an arrival the app fetched past it was never in the count, so it
/// cannot stand in for an old row a backfill has not reached. No recorded
/// count (a Graph folder, a cache the app wrote): the rows are the listing,
/// as before.
fn folder_listing(conn: &Connection, account: &str, vault_dir: &str) -> Result<FolderListing, String> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT mailbox_path FROM header_cache WHERE account_id=?1 UNION SELECT mailbox_path FROM header_cache_meta WHERE account_id=?1",
        )
        .map_err(err)?;
    let mailboxes = stmt
        .query_map([account], |r| r.get::<_, String>(0))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    let mut readable = Vec::new();
    let mut counted_empty = false;
    for mailbox in mailboxes.into_iter().filter(|m| crate::search_index::text::vault_dir_name(m) == vault_dir) {
        let rows = count(conn, account, &mailbox)? as u64;
        let (server, uid_next) = recorded_count(conn, account, &mailbox)?;
        // The rows the daemon's count covers: those below its `syncUidNext`.
        let judged = match (server, uid_next) {
            (Some(_), Some(next)) => conn
                .query_row(
                    "SELECT count(*) FROM header_cache WHERE account_id=?1 AND mailbox_path=?2 AND uid < ?3",
                    params![account, mailbox, next],
                    |r| r.get::<_, i64>(0),
                )
                .map_err(err)?,
            _ => rows as i64,
        };
        match (rows, server) {
            (_, Some(total)) if judged < total => {
                return Ok(FolderListing::Partial(format!("{mailbox} holds {judged} of {total} headers")));
            }
            (0, Some(_)) => counted_empty = true,
            (0, None) => {}
            _ => readable.push(mailbox),
        }
    }
    Ok(if readable.is_empty() && !counted_empty { FolderListing::Unknown } else { FolderListing::Complete(readable) })
}

/// What `mailbox`'s rows are judged complete against (`folder_listing`): the
/// server's count the daemon's sync last recorded (`syncTotalEmails`) less
/// what the app's own writes took off since (`APP_REMOVED_SINCE_SYNC`), and
/// the `syncUidNext` it was taken at. `None`s: no count recorded (a Graph
/// folder, a cache the app wrote), where the rows are the listing.
pub fn recorded_count(conn: &Connection, account: &str, mailbox: &str) -> Result<(Option<i64>, Option<i64>), String> {
    use rusqlite::OptionalExtension;
    Ok(conn
        .query_row(
            "SELECT CASE WHEN json_valid(meta_json) AND json_extract(meta_json, '$.syncTotalEmails') IS NOT NULL
                         THEN max(0, json_extract(meta_json, '$.syncTotalEmails')
                                     - coalesce(json_extract(meta_json, '$.appRemovedSinceSync'), 0)) END,
                    CASE WHEN json_valid(meta_json) THEN json_extract(meta_json, '$.syncUidNext') END
             FROM header_cache_meta WHERE account_id=?1 AND mailbox_path=?2",
            params![account, mailbox],
            |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<i64>>(1)?)),
        )
        .optional()
        .map_err(err)?
        .unwrap_or((None, None)))
}

/// Whether the cache knows `account` at all: a header row, a folder's meta or
/// its folder list. Three index seeks, never a scan.
pub fn knows_account(conn: &Connection, account: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM header_cache WHERE account_id=?1)
             OR EXISTS(SELECT 1 FROM header_cache_meta WHERE account_id=?1)
             OR EXISTS(SELECT 1 FROM mailbox_cache WHERE account_id=?1)",
        [account],
        |r| r.get(0),
    )
    .map_err(err)
}

/// Every mailbox of `account` with a meta row: one per folder a sync or the
/// app recorded, rows or not. A folder the sync counted but whose rows are
/// gone (a wipe, a refill part way) is only here.
pub fn mailboxes_with_meta(conn: &Connection, account: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare_cached("SELECT mailbox_path FROM header_cache_meta WHERE account_id=?1").map_err(err)?;
    let rows = stmt.query_map([account], |r| r.get::<_, String>(0)).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err);
    rows
}

/// The first mailbox of `account` after `after` (by name) that holds a header
/// row: one index seek, so walking every mailbox of a large account holds the
/// custody lock one short step at a time, never for a scan of its rows.
pub fn next_mailbox_with_headers(conn: &Connection, account: &str, after: Option<&str>) -> Result<Option<String>, String> {
    use rusqlite::OptionalExtension;
    match after {
        None => conn
            .query_row("SELECT mailbox_path FROM header_cache WHERE account_id=?1 ORDER BY mailbox_path LIMIT 1", [account], |r| r.get(0))
            .optional(),
        Some(after) => conn
            .query_row(
                "SELECT mailbox_path FROM header_cache WHERE account_id=?1 AND mailbox_path > ?2 ORDER BY mailbox_path LIMIT 1",
                params![account, after],
                |r| r.get(0),
            )
            .optional(),
    }
    .map_err(err)
}

/// Up to `limit` of `mailbox`'s cached `(uid, sort_ms)` after uid `after`,
/// ascending: one page of a walk over a folder of any size, each page its own
/// unit of the caller's lock. Never parses a row.
pub fn uid_dates_after(conn: &Connection, account: &str, mailbox: &str, after: Option<u32>, limit: usize) -> Result<Vec<(u32, i64)>, String> {
    let from = after.map_or(-1, i64::from);
    let mut stmt = conn
        .prepare_cached(
            "SELECT uid, sort_ms FROM header_cache WHERE account_id=?1 AND mailbox_path=?2 AND uid > ?3 ORDER BY uid LIMIT ?4",
        )
        .map_err(err)?;
    let rows = stmt
        .query_map(params![account, mailbox, from, limit as i64], |r| Ok((r.get::<_, u32>(0)?, r.get::<_, i64>(1)?)))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err);
    rows
}

/// One chunk of the lookup over `mailboxes`.
fn listed_chunk(
    conn: &Connection,
    account: &str,
    mailboxes: &[String],
    chunk: &[u32],
    out: &mut HashMap<u32, Option<String>>,
) -> Result<(), String> {
    let marks = std::iter::repeat_n("?", chunk.len()).collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT uid, CASE WHEN json_valid(header_json)
                          THEN COALESCE(json_extract(header_json, '$.messageId'), json_extract(header_json, '$.message_id')) END
         FROM header_cache WHERE account_id=? AND mailbox_path=? AND uid IN ({marks})"
    );
    for mailbox in mailboxes {
        let mut args: Vec<rusqlite::types::Value> = vec![account.to_string().into(), mailbox.clone().into()];
        args.extend(chunk.iter().map(|u| i64::from(*u).into()));
        let mut stmt = conn.prepare_cached(&sql).map_err(err)?;
        let found = stmt
            .query_map(params_from_iter(args), |r| {
                let id = match r.get::<_, rusqlite::types::Value>(1)? {
                    rusqlite::types::Value::Text(s) => Some(s),
                    _ => None,
                };
                Ok((r.get::<_, u32>(0)?, id))
            })
            .map_err(err)?;
        for row in found {
            let (uid, id) = row.map_err(err)?;
            out.insert(uid, id);
        }
    }
    Ok(())
}

/// Every cached header of every mailbox behind vault folder `vault_dir`: what
/// a fresh (rebuilt) index adds header-only rows from for mail no file holds.
/// A folder the header cache has never seen has none; one whose cache is
/// partial (`FolderListing::Partial`) is `Err`, so the fill waits for it
/// rather than miss the old, evicted mail a refill reaches last.
///
/// ponytail: one read of the whole folder under the caller's lock, run once
/// per fresh index; chunk it by uid if a huge folder's first pass shows.
pub fn folder_headers(conn: &Connection, account: &str, vault_dir: &str) -> Result<Vec<Value>, String> {
    let mailboxes = match folder_listing(conn, account, vault_dir)? {
        FolderListing::Unknown => return Ok(Vec::new()),
        listing => listing.readable(account, vault_dir)?,
    };
    let mut out = Vec::new();
    for mailbox in mailboxes {
        out.extend(all_headers(conn, account, &mailbox)?);
    }
    Ok(out)
}

/// Every cached header of one mailbox, newest first — what a consumer that
/// used to walk the sidecar directory (the classifier, the contacts cold
/// build) reads instead.
pub fn all_headers(conn: &Connection, account: &str, mailbox: &str) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT header_json FROM header_cache WHERE account_id=?1 AND mailbox_path=?2
             ORDER BY sort_ms DESC, uid DESC",
        )
        .map_err(err)?;
    let rows = stmt
        .query_map(params![account, mailbox], |r| r.get::<_, String>(0))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(rows.into_iter().filter_map(|s| serde_json::from_str(&s).ok()).collect())
}

/// Every (account, mailbox) the header cache holds rows for — the listing a
/// consumer that used to walk `email_cache/` for `<account>_<mailbox>` dirs
/// needs. `account` narrows it when the caller only wants one.
pub fn mailboxes_with_headers(conn: &Connection, account: Option<&str>) -> Result<Vec<(String, String)>, String> {
    let (sql, filter): (&str, Vec<&str>) = match account {
        Some(a) => (
            "SELECT DISTINCT account_id, mailbox_path FROM header_cache WHERE account_id=?1 ORDER BY mailbox_path",
            vec![a],
        ),
        None => ("SELECT DISTINCT account_id, mailbox_path FROM header_cache ORDER BY account_id, mailbox_path", vec![]),
    };
    let mut stmt = conn.prepare(sql).map_err(err)?;
    let rows = stmt
        .query_map(params_from_iter(filter), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(rows)
}

/// Message-ID → uid for the mailbox's current generation, plus how many
/// headers it was built from. The generation repair's input; it read the
/// sidecar files before the headers moved in here.
pub fn message_id_map(conn: &Connection, account: &str, mailbox: &str) -> Result<(HashMap<String, u32>, u64), String> {
    let mut map = HashMap::new();
    let mut seen = 0u64;
    for header in all_headers(conn, account, mailbox)? {
        seen += 1;
        // Rows written by the frontend carry `messageId`; ones serialized from
        // `EmailHeader` carry `message_id`.
        let Some(raw) = header.get("messageId").or_else(|| header.get("message_id")).and_then(Value::as_str) else {
            continue;
        };
        let Some(uid) = header.get("uid").and_then(Value::as_u64).and_then(|u| u32::try_from(u).ok()) else {
            continue;
        };
        let id = crate::maildir::normalize_message_id(raw);
        if !id.is_empty() {
            map.insert(id, uid);
        }
    }
    Ok((map, seen))
}

/// What the sync engine last recorded for this mailbox: the UIDVALIDITY its
/// uids belong to, and how many messages the server said it holds.
pub fn sync_meta(conn: &Connection, account: &str, mailbox: &str) -> Result<(Option<u32>, Option<u64>), String> {
    let Some(text) = load_meta(conn, account, mailbox)? else { return Ok((None, None)) };
    let meta: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok((
        meta.get("uidValidity").and_then(Value::as_u64).map(|v| v as u32),
        meta.get("totalEmails").and_then(Value::as_u64),
    ))
}

pub fn patch_flags(conn: &Connection, account: &str, mailbox: &str, changes: &[(u32, Vec<String>)]) -> Result<usize, String> {
    let changes: Vec<FlagChange> = changes.iter().map(|(uid, flags)| FlagChange { uid: *uid, flags: flags.clone(), on: None }).collect();
    patch_changes(conn, account, mailbox, &changes)
}

/// `patch_flags` for the vault's writer: a delta is read against the cached
/// header's own flags, in the same transaction, so its keywords survive.
pub fn patch_changes(conn: &Connection, account: &str, mailbox: &str, changes: &[FlagChange]) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    let mut changed = 0;
    for change in changes {
        let uid = change.uid;
        let current: Option<String> = tx.query_row(
            "SELECT header_json FROM header_cache WHERE account_id=?1 AND mailbox_path=?2 AND uid=?3",
            params![account, mailbox, uid], |r| r.get(0),
        ).ok();
        let Some(text) = current else { continue };
        let mut row: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let held: Vec<String> = row.get("flags").and_then(|f| serde_json::from_value(f.clone()).ok()).unwrap_or_default();
        let next = json!(change.over(&held));
        if row.get("flags") == Some(&next) { continue; }
        let Some(map) = row.as_object_mut() else { continue };
        map.insert("flags".into(), next);
        changed += tx.execute(
            "UPDATE header_cache SET header_json=?4,updated_ms=?5 WHERE account_id=?1 AND mailbox_path=?2 AND uid=?3",
            params![account, mailbox, uid, serde_json::to_string(&row).map_err(|e| e.to_string())?, now_ms()],
        ).map_err(err)?;
    }
    tx.commit().map_err(err)?;
    Ok(changed)
}

pub fn clear_headers(conn: &Connection, account: Option<&str>, mailbox: Option<&str>) -> Result<(), String> {
    match (account, mailbox) {
        (Some(a), Some(m)) => {
            conn.execute("DELETE FROM header_cache WHERE account_id=?1 AND mailbox_path=?2", params![a,m]).map_err(err)?;
            conn.execute("DELETE FROM header_cache_meta WHERE account_id=?1 AND mailbox_path=?2", params![a,m]).map_err(err)?;
            crate::people::message_addr::forget_mailbox(conn, Some(a), Some(m))?;
        }
        (Some(a), None) => {
            conn.execute("DELETE FROM header_cache WHERE account_id=?1", [a]).map_err(err)?;
            conn.execute("DELETE FROM header_cache_meta WHERE account_id=?1", [a]).map_err(err)?;
            crate::people::message_addr::forget_mailbox(conn, Some(a), None)?;
        }
        (None, _) => {
            conn.execute("DELETE FROM header_cache", []).map_err(err)?;
            conn.execute("DELETE FROM header_cache_meta", []).map_err(err)?;
            crate::people::message_addr::forget_mailbox(conn, None, None)?;
        }
    }
    Ok(())
}

pub fn prune_headers(conn: &Connection, account: &str, mailbox: &str, live_uids: &[u32]) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    let live = live_uids.iter().copied().collect::<std::collections::HashSet<_>>();
    let mut stmt = tx.prepare("SELECT uid FROM header_cache WHERE account_id=?1 AND mailbox_path=?2").map_err(err)?;
    let cached = stmt.query_map(params![account, mailbox], |r| r.get::<_, u32>(0)).map_err(err)?
        .collect::<Result<Vec<_>, _>>().map_err(err)?;
    drop(stmt);
    let mut removed = 0;
    let mut delete = tx.prepare_cached("DELETE FROM header_cache WHERE account_id=?1 AND mailbox_path=?2 AND uid=?3").map_err(err)?;
    for uid in cached.into_iter().filter(|uid| !live.contains(uid)) {
        removed += delete.execute(params![account, mailbox, uid]).map_err(err)?;
        crate::people::message_addr::forget_row(&tx, account, mailbox, uid)?;
    }
    drop(delete);
    tx.commit().map_err(err)?;
    Ok(removed)
}

/// Drop exactly these rows: what the server said is gone. Unlike
/// `prune_headers` it needs no list of what is live, so a row written between
/// the server's answer and this delete is never taken with them.
pub fn remove_headers(conn: &Connection, account: &str, mailbox: &str, uids: &[u32]) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    let mut removed = 0;
    let mut delete = tx.prepare_cached("DELETE FROM header_cache WHERE account_id=?1 AND mailbox_path=?2 AND uid=?3").map_err(err)?;
    for uid in uids {
        removed += delete.execute(params![account, mailbox, uid]).map_err(err)?;
        crate::people::message_addr::forget_row(&tx, account, mailbox, *uid)?;
    }
    drop(delete);
    tx.commit().map_err(err)?;
    Ok(removed)
}

/// Put back rows the cache lost while the server still lists their uids (the
/// sync's hole heal). Writes only a uid that has no row: one the app or a sync
/// wrote since this fetch is newer and stays. The meta is not touched, so the
/// app's `appRemovedSinceSync` tally and every count stay as they are. Returns
/// the uids actually written.
pub fn restore_missing_headers(conn: &Connection, account: &str, mailbox: &str, rows: &[Value]) -> Result<Vec<u32>, String> {
    restore_missing_headers_for(conn, account, mailbox, rows, None)
}

pub fn restore_missing_headers_bound(conn: &Connection, account: &str, mailbox: &str, rows: &[Value], identity: &crate::imap::NativeHeaderIdentity) -> Result<Vec<u32>, String> {
    restore_missing_headers_for(conn, account, mailbox, rows, Some(identity))
}

fn restore_missing_headers_for(conn: &Connection, account: &str, mailbox: &str, rows: &[Value], identity: Option<&crate::imap::NativeHeaderIdentity>) -> Result<Vec<u32>, String> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    let raw_meta: Option<String> = tx.query_row("SELECT meta_json FROM header_cache_meta WHERE account_id=?1 AND mailbox_path=?2", params![account, mailbox], |r| r.get(0)).optional().map_err(err)?;
    let meta = raw_meta.map(|s| serde_json::from_str::<Value>(&s).map_err(|e| e.to_string())).transpose()?;
    let current = meta.as_ref().and_then(|v| v.get("nativeIdentity")).filter(|v| !v.is_null())
        .map(|v| serde_json::from_value::<crate::imap::NativeHeaderIdentity>(v.clone()).map_err(|e| e.to_string())).transpose()?;
    if identity.is_some() && current.is_some() && current.as_ref() != identity { return Err("errors.bulkIdentityChanged".into()); }
    let preserve = identity.is_some() && current.as_ref() == identity;
    let mut restored = Vec::new();
    {
        let mut stmt = tx.prepare_cached(
            "INSERT OR IGNORE INTO header_cache(account_id,mailbox_path,uid,sort_ms,updated_ms,header_json) VALUES (?1,?2,?3,?4,?5,?6)"
        ).map_err(err)?;
        let written_at = now_ms();
        for row in rows {
            let Some(uid) = row.get("uid").and_then(Value::as_u64).and_then(|u| u32::try_from(u).ok()) else { continue };
            let json = serde_json::to_string(row).map_err(|e| e.to_string())?;
            if stmt.execute(params![account, mailbox, uid, sort_ms(row), written_at, json]).map_err(err)? == 1 {
                crate::people::message_addr::index_row(&tx, account, mailbox, uid, sort_ms(row), row)?;
                restored.push(uid);
            }
        }
    }
    if !restored.is_empty() && !preserve && current.is_some() {
        let mut meta = meta.ok_or("errors.bulkIdentityUncertain")?;
        meta.as_object_mut().ok_or("stored cache metadata is not an object")?.remove("nativeIdentity");
        tx.execute("UPDATE header_cache_meta SET meta_json=?3 WHERE account_id=?1 AND mailbox_path=?2", params![account, mailbox, meta.to_string()]).map_err(err)?;
    }
    tx.commit().map_err(err)?;
    Ok(restored)
}

pub fn rename_mailbox(conn: &Connection, account: &str, from: &str, to: &str) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    // header rows of the target that the move replaces lose their address rows too; the rest of the target keeps its own
    tx.execute(
        "DELETE FROM message_addr WHERE account_id=?1 AND mailbox_path=?3 AND uid IN (SELECT uid FROM header_cache WHERE account_id=?1 AND mailbox_path=?2)",
        params![account, from, to],
    )
    .map_err(err)?;
    tx.execute("UPDATE OR REPLACE header_cache SET mailbox_path=?3 WHERE account_id=?1 AND mailbox_path=?2", params![account,from,to]).map_err(err)?;
    tx.execute("UPDATE OR REPLACE header_cache_meta SET mailbox_path=?3 WHERE account_id=?1 AND mailbox_path=?2", params![account,from,to]).map_err(err)?;
    crate::people::message_addr::rename_mailbox(&tx, account, from, to)?;
    tx.commit().map_err(err)
}

pub fn save_mailboxes(conn: &Connection, account: &str, data: &str) -> Result<(), String> {
    serde_json::from_str::<Value>(data).map_err(|e| format!("Failed to parse mailbox cache JSON: {e}"))?;
    conn.execute("INSERT OR REPLACE INTO mailbox_cache(account_id,cache_json) VALUES (?1,?2)", params![account,data]).map_err(err)?;
    Ok(())
}
pub fn load_mailboxes(conn: &Connection, account: &str) -> Result<Option<String>, String> {
    use rusqlite::OptionalExtension;
    conn.query_row("SELECT cache_json FROM mailbox_cache WHERE account_id=?1", [account], |r| r.get(0)).optional().map_err(err)
}
pub fn delete_mailboxes(conn: &Connection, account: &str) -> Result<(), String> {
    conn.execute("DELETE FROM mailbox_cache WHERE account_id=?1", [account]).map(|_| ()).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custody::db::open;
    use chrono::{TimeZone, Utc};

    fn store() -> (tempfile::TempDir, Connection) {
        let tmp = tempfile::tempdir().unwrap();
        let conn = open(tmp.path()).unwrap();
        (tmp, conn)
    }

    fn ms(y: i32, m: u32, d: u32) -> i64 {
        Utc.with_ymd_and_hms(y, m, d, 12, 0, 0).unwrap().timestamp_millis()
    }

    fn insert(conn: &Connection, account: &str, mailbox: &str, uid: i64, sort_ms: i64) {
        conn.execute(
            "INSERT INTO header_cache(account_id,mailbox_path,uid,sort_ms,updated_ms,header_json) VALUES (?1,?2,?3,?4,?5,?6)",
            params![account, mailbox, uid, sort_ms, 0i64, "{}"],
        ).unwrap();
    }

    #[test]
    fn month_histogram_groups_filters_excludes_unknown_dates_and_orders_newest_first() {
        let (_t, c) = store();
        // account a / INBOX: three months, three rows in 2021-03.
        insert(&c, "a", "INBOX", 1, ms(2021, 3, 1));
        insert(&c, "a", "INBOX", 2, ms(2021, 3, 15));
        insert(&c, "a", "INBOX", 3, ms(2021, 3, 28));
        insert(&c, "a", "INBOX", 4, ms(2021, 1, 5));
        insert(&c, "a", "INBOX", 5, ms(2020, 12, 31));
        // sort_ms <= 0 is an unknown date and must be excluded, not bucketed.
        insert(&c, "a", "INBOX", 6, 0);
        // Another mailbox on the same account must not leak in.
        insert(&c, "a", "Archive", 7, ms(2021, 3, 1));
        // Another account, same mailbox name, must not leak in either.
        insert(&c, "b", "INBOX", 8, ms(2021, 3, 1));

        let result = month_histogram(&c, "a", "INBOX").unwrap();
        assert_eq!(
            result,
            json!([
                {"ym": "2021-03", "count": 3},
                {"ym": "2021-01", "count": 1},
                {"ym": "2020-12", "count": 1},
            ])
        );
    }

    /// Past SQLite's bound-parameter limit (32766) a single `IN (...)`
    /// failed outright; the chunked query returns every row, deduplicated,
    /// in the one `sort_ms DESC, uid DESC` order across chunk boundaries.
    #[test]
    fn load_by_uids_returns_every_row_in_order_past_the_parameter_limit() {
        let (_t, mut c) = store();
        let tx = c.transaction().unwrap();
        {
            let mut stmt = tx.prepare(
                "INSERT INTO header_cache(account_id,mailbox_path,uid,sort_ms,updated_ms,header_json) VALUES ('a','INBOX',?1,?2,0,?3)"
            ).unwrap();
            // sort_ms repeats every 1000 uids, so ties exercise the uid DESC tiebreak.
            for uid in 1..=40_000u32 {
                stmt.execute(params![uid, i64::from(uid % 1000), json!({"uid": uid}).to_string()]).unwrap();
            }
        }
        tx.commit().unwrap();
        insert(&c, "a", "Archive", 5, 5_000);

        let mut uids: Vec<u32> = (1..=40_000).rev().collect();
        uids.push(7); // a duplicate
        uids.push(50_000); // not cached
        let got = load_by_uids(&c, "a", "INBOX", &uids).unwrap()
            .iter().map(|v| v["uid"].as_u64().unwrap() as u32).collect::<Vec<_>>();

        let mut expected: Vec<u32> = (1..=40_000).collect();
        expected.sort_by(|a, b| (b % 1000).cmp(&(a % 1000)).then(b.cmp(a)));
        assert_eq!(got.len(), 40_000);
        assert_eq!(got, expected);
    }

    /// Just the uid and the flags, without parsing the rest of each header:
    /// every cached uid asked for once, by uid, across chunk boundaries; a
    /// row with no flags has none, an unparseable row is not listed (as
    /// `load_by_uids` drops it), another mailbox never leaks in.
    #[test]
    fn flags_by_uids_reads_each_listed_uids_flags_and_nothing_else() {
        let (_t, mut c) = store();
        let total = UID_CHUNK as u32 + 10;
        let tx = c.transaction().unwrap();
        {
            let mut stmt = tx.prepare(
                "INSERT INTO header_cache(account_id,mailbox_path,uid,sort_ms,updated_ms,header_json) VALUES ('a','INBOX',?1,?2,0,?3)"
            ).unwrap();
            for uid in 1..=total {
                let header = match uid {
                    3 => json!({"uid": uid, "subject": "no flags"}).to_string(),
                    4 => "{not json".to_string(),
                    _ if uid % 2 == 0 => json!({"uid": uid, "flags": ["\\Seen", "\\Flagged"]}).to_string(),
                    _ => json!({"uid": uid, "flags": []}).to_string(),
                };
                stmt.execute(params![uid, i64::from(total - uid), header]).unwrap();
            }
        }
        tx.commit().unwrap();
        c.execute(
            "INSERT INTO header_cache(account_id,mailbox_path,uid,sort_ms,updated_ms,header_json) VALUES ('a','Archive',2,0,0,?1)",
            params![json!({"uid": 2, "flags": ["\\Draft"]}).to_string()],
        ).unwrap();

        let mut wanted: Vec<u32> = (1..=total).rev().collect();
        wanted.push(2); // a duplicate
        wanted.push(50_000); // not cached
        let got = flags_by_uids(&c, "a", "INBOX", &wanted).unwrap();

        let expected: Vec<(u32, Vec<String>)> = (1..=total)
            .filter(|uid| *uid != 4)
            .map(|uid| {
                let flags = if uid != 3 && uid % 2 == 0 { vec!["\\Seen".to_string(), "\\Flagged".to_string()] } else { Vec::new() };
                (uid, flags)
            })
            .collect();
        assert_eq!(got, expected);
    }

    fn put_header(c: &Connection, account: &str, mailbox: &str, uid: u32, header: &str) {
        c.execute(
            "INSERT INTO header_cache(account_id,mailbox_path,uid,sort_ms,updated_ms,header_json) VALUES (?1,?2,?3,0,0,?4)",
            params![account, mailbox, uid, header],
        ).unwrap();
    }

    /// The vault names a folder by `vault_dir_name`, the header cache by the
    /// server path: the answer is keyed the way the search index keys a row. A
    /// header with no `\Seen` is unread (whatever case the server spells it);
    /// one that does not parse says nothing; two server paths that spell one
    /// vault folder and disagree on a uid say nothing about it; `uids` narrows
    /// the read; a Message-ID rides along to tell a reissued uid.
    #[test]
    fn read_states_resolve_one_vault_folder_by_one_rule() {
        let (_t, c) = store();
        let put = |account: &str, mailbox: &str, uid: u32, header: &str| put_header(&c, account, mailbox, uid, header);
        put("a", "INBOX", 1, &json!({"uid": 1, "messageId": "<one@x.test>", "flags": ["\\Seen"]}).to_string());
        put("a", "INBOX", 2, &json!({"uid": 2, "flags": ["\\Flagged"]}).to_string());
        put("a", "INBOX", 3, &json!({"uid": 3}).to_string());
        put("a", "INBOX", 4, "{not json");
        put("a", "INBOX", 5, &json!({"uid": 5, "flags": ["\\SEEN"]}).to_string());
        put("a", "Projects/2026", 1, &json!({"uid": 1, "flags": ["\\Seen"]}).to_string());
        put("a", "Clash a", 7, &json!({"uid": 7, "flags": ["\\Seen"]}).to_string());
        put("a", "Clash/a", 7, &json!({"uid": 7, "flags": []}).to_string());
        put("a", "Clash/a", 8, &json!({"uid": 8, "flags": []}).to_string());
        put("b", "INBOX", 1, &json!({"uid": 1, "flags": ["\\Seen"]}).to_string());

        let folders = vault_folders(&c, "a").unwrap();
        let mut names: Vec<&String> = folders.keys().collect();
        names.sort();
        assert_eq!(names, vec!["Clash_a", "INBOX", "Projects_2026"]);
        assert_eq!(folders["Clash_a"].len(), 2, "two server paths, one vault folder");

        let (inbox, next) = read_states_after(&c, "a", &folders["INBOX"], 0).unwrap();
        assert_eq!(next, None);
        let got: Vec<(u32, bool)> = { let mut v: Vec<_> = inbox.iter().map(|(u, s)| (*u, s.seen)).collect(); v.sort_unstable(); v };
        assert_eq!(got, vec![(1, true), (2, false), (3, false), (5, true)], "uid 4 does not parse");
        assert_eq!(inbox[&1].message_id.as_deref(), Some("one@x.test"), "angle brackets come off");
        assert_eq!(inbox[&2].message_id, None);

        let only = read_states_of(&c, "a", &folders["INBOX"], &[2, 5, 99]).unwrap();
        assert_eq!(only.keys().copied().collect::<std::collections::BTreeSet<_>>(), [2, 5].into(), "narrowed; an uncached uid is absent");

        let (clash, _) = read_states_after(&c, "a", &folders["Clash_a"], 0).unwrap();
        assert_eq!(clash.keys().copied().collect::<Vec<_>>(), vec![8], "uid 7 is read in one path and unread in the other");
        assert_eq!(read_states_after(&c, "a", &folders["Projects_2026"], 0).unwrap().0.len(), 1);
        assert!(read_states_after(&c, "a", &[], 0).unwrap().0.is_empty());
    }

    /// A folder is read a unit at a time, across the server paths that share
    /// it, and every uid comes out once, with the cursor never skipping or
    /// repeating one.
    #[test]
    fn read_states_walk_a_folder_in_bounded_units() {
        let (_t, mut c) = store();
        let total = READ_STATE_UNIT as u32 * 2 + 50;
        {
            let tx = c.transaction().unwrap();
            for uid in 1..=total {
                // Even uids live under one server path, odd under the other; a
                // spare (uid 3) is in both and agrees.
                let mailbox = if uid % 2 == 0 { "Clash a" } else { "Clash/a" };
                let flags = if uid % 3 == 0 { json!(["\\Seen"]) } else { json!([]) };
                let header = json!({"uid": uid, "flags": flags}).to_string();
                put_header(&tx, "a", mailbox, uid, &header);
                if uid == 3 {
                    put_header(&tx, "a", "Clash a", uid, &header);
                }
            }
            tx.commit().unwrap();
        }
        let paths = vault_folders(&c, "a").unwrap().remove("Clash_a").unwrap();
        let (mut after, mut units, mut seen_uids) = (0u32, 0, Vec::new());
        loop {
            let (unit, next) = read_states_after(&c, "a", &paths, after).unwrap();
            assert!(unit.len() <= READ_STATE_UNIT, "a custody hold reads {} rows", unit.len());
            units += 1;
            seen_uids.extend(unit.iter().map(|(uid, state)| { assert_eq!(state.seen, uid % 3 == 0); *uid }));
            match next { Some(cursor) => after = cursor, None => break }
        }
        seen_uids.sort_unstable();
        assert_eq!(units, 3);
        assert_eq!(seen_uids, (1..=total).collect::<Vec<_>>());
    }

    #[test]
    fn a_read_state_speaks_for_a_message_unless_the_message_ids_differ() {
        let state = |id: Option<&str>| ReadState { seen: true, message_id: id.and_then(message_id_key) };
        assert!(state(Some("<a@x.test>")).applies_to(Some(" a@x.test ")), "brackets and spaces do not matter");
        assert!(!state(Some("<a@x.test>")).applies_to(Some("<b@x.test>")), "a reissued uid: another message");
        assert!(state(None).applies_to(Some("<b@x.test>")), "a header with no Message-ID cannot say");
        assert!(state(Some("<a@x.test>")).applies_to(None));
        assert!(state(Some("<a@x.test>")).applies_to(Some("<>")), "an empty one is none");
    }

    #[test]
    fn date_offset_reads_the_numeric_zone_and_nothing_else() {
        let cases: &[(&str, Option<i32>)] = &[
            ("Tue, 22 Sep 2026 10:00:00 +0300", Some(180)),
            ("Tue, 22 Sep 2026 10:00:00 -0400", Some(-240)),
            ("Tue, 22 Sep 2026 10:00:00 +0530 (IST)", Some(330)),
            ("22 Sep 2026 10:00 -0930", Some(-570)),
            ("Tue, 22 Sep 2026 10:00:00 +0000", None),
            ("Tue, 22 Sep 2026 10:00:00 -0000", None),
            ("2026-09-09T00:30:00Z", None),
            ("2026-09-09T00:30:00+03:00", None),
            ("Tue, 22 Sep 2026 10:00:00 GMT", None),
            ("Tue, 22 Sep 2026 10:00:00 +03", None),
            ("Tue, 22 Sep 2026 10:00:00 +9900", None),
            ("Tue, 22 Sep 2026 10:00:00 +03a0", None),
            ("", None),
            ("garbage", None),
        ];
        for (date, want) in cases {
            assert_eq!(date_offset_minutes(date), *want, "{date:?}");
        }
    }

    fn put(c: &Connection, account: &str, mailbox: &str, uid: i64, sort_ms: i64, row: Value) {
        c.execute(
            "INSERT INTO header_cache(account_id,mailbox_path,uid,sort_ms,updated_ms,header_json) VALUES (?1,?2,?3,?4,?5,?6)",
            params![account, mailbox, uid, sort_ms, 0i64, row.to_string()],
        ).unwrap();
    }

    fn utc(y: i32, m: u32, d: u32, h: u32) -> i64 {
        Utc.with_ymd_and_hms(y, m, d, h, 0, 0).unwrap().timestamp_millis()
    }

    /// Every page of one folder, the way the follow-up worker reads it.
    fn replied_in(c: &Connection, mailbox: &str, id: &str, own: &[&str]) -> bool {
        let wanted = [ReplyWanted { key: "k".into(), message_id: id.into(), own: own.iter().map(|s| s.to_string()).collect() }];
        let mut after = 0;
        loop {
            let page = reply_scan_page_many(c, "a", mailbox, &wanted, after, 2).unwrap();
            if !page.replied.is_empty() {
                return true;
            }
            match page.next_after {
                Some(next) => after = next,
                None => return false,
            }
        }
    }

    /// `notes_to_self::normalize_identity`, the mirror of the app's
    /// `normalizeEmailIdentity`: a Gmail login is one inbox however its
    /// address is spelled.
    #[test]
    fn a_nudge_from_the_login_spelled_another_gmail_way_is_no_reply() {
        let (_t, c) = store();
        put(&c, "a", "INBOX", 1, 1, json!({"uid": 1, "inReplyTo": "<g@me.x>", "from": {"address": "john.doe@gmail.com"}}));
        put(&c, "a", "INBOX", 2, 2, json!({"uid": 2, "inReplyTo": "<g@me.x>", "from": {"address": "JohnDoe+x@gmail.com"}}));
        assert!(!replied_in(&c, "INBOX", "<g@me.x>", &["johndoe@googlemail.com"]));
        put(&c, "a", "INBOX", 3, 3, json!({"uid": 3, "inReplyTo": "<g@me.x>", "from": {"address": "john.doe@example.com"}}));
        assert!(replied_in(&c, "INBOX", "<g@me.x>", &["johndoe@googlemail.com"]), "dots matter outside Gmail");
    }

    #[test]
    fn message_ids_match_whatever_their_case() {
        let (_t, c) = store();
        put(&c, "a", "INBOX", 1, 1, json!({"uid": 1, "inReplyTo": "<ABC.1@Mail.X>", "from": {"address": "ana@y.com"}}));
        assert!(replied_in(&c, "INBOX", "<abc.1@mail.x>", &["me@x.com"]));
    }

    #[test]
    fn local_wake_message_id_requires_exactly_one_current_cached_uid() {
        let (_t, c) = store();
        put(&c, "a", "INBOX", 5, 5, json!({"uid":5,"messageId":"<held@x.test>"}));
        put(&c, "a", "INBOX", 6, 6, json!({"uid":6,"messageId":"held@x.test"}));
        put(&c, "b", "INBOX", 7, 7, json!({"uid":7,"messageId":"held@x.test"}));
        assert_eq!(unique_uid_by_message_id(&c, "a", "INBOX", "<held@x.test>")
            .unwrap_err(), "ambiguous-message");
        c.execute("DELETE FROM header_cache WHERE account_id='a' AND mailbox_path='INBOX' AND uid=6", []).unwrap();
        assert_eq!(unique_uid_by_message_id(&c, "a", "INBOX", "<held@x.test>").unwrap(), Some(5));
        assert_eq!(unique_uid_by_message_id(&c, "a", "Archive", "<held@x.test>").unwrap(), None);
    }

    /// One read of a page answers for every reminder of the account at once.
    #[test]
    fn one_page_answers_for_every_message_asked_about() {
        let (_t, c) = store();
        put(&c, "a", "INBOX", 1, 1, json!({"uid": 1, "inReplyTo": "<one@me.x>", "from": {"address": "ana@y.com"}}));
        put(&c, "a", "INBOX", 2, 2, json!({"uid": 2, "references": ["<two@me.x>"], "from": {"address": "bo@y.com"}}));
        put(&c, "a", "INBOX", 3, 3, json!({"uid": 3, "inReplyTo": "<three@me.x>", "from": {"address": "me@x.com"}}));
        let own = vec!["me@x.com".to_string()];
        let want = |key: &str, id: &str| ReplyWanted { key: key.into(), message_id: id.into(), own: own.clone() };
        let page = reply_scan_page_many(&c, "a", "INBOX", &[want("1", "<one@me.x>"), want("2", "<two@me.x>"), want("3", "<three@me.x>")], 0, 10).unwrap();
        let mut replied = page.replied.clone();
        replied.sort();
        assert_eq!(replied, vec!["1", "2"]);
        assert_eq!(page.next_after, None);
    }

    #[test]
    fn a_cached_reply_is_someone_elses_message_naming_the_id() {
        let (_t, c) = store();
        put(&c, "a", "INBOX", 1, 1, json!({"uid": 1, "subject": "Re: Quote", "inReplyTo": "<q_1@me.x>", "from": {"address": "ana@y.com"}}));
        assert!(replied_in(&c, "INBOX", "<q_1@me.x>", &["me@x.com"]));
        // Named in References only, without brackets, among others; on a later page.
        for uid in 2..6 {
            put(&c, "a", "Trash", uid, uid, json!({"uid": uid, "subject": "noise", "from": {"address": "x@y.com"}}));
        }
        put(&c, "a", "Trash", 9, 9, json!({"uid": 9, "references": ["<root@y.com>", "r2@me.x"], "from": {"address": "ana@y.com"}}));
        assert!(replied_in(&c, "Trash", "<r2@me.x>", &["me@x.com"]));
        // A reference string, as some rows carry it.
        put(&c, "a", "Archive", 1, 1, json!({"uid": 1, "references": "<r@y.com> <s3@me.x>", "from": {"address": "bo@y.com"}}));
        assert!(replied_in(&c, "Archive", "<s3@me.x>", &["me@x.com"]));
    }

    #[test]
    fn the_senders_own_addresses_are_no_reply_compared_whole_and_without_case() {
        let (_t, c) = store();
        let own = ["me@x.com", "Alias@X.com"];
        put(&c, "a", "INBOX", 1, 1, json!({"uid": 1, "inReplyTo": "<q@me.x>", "from": {"address": "alias@x.com"}}));
        put(&c, "a", "INBOX", 2, 2, json!({"uid": 2, "inReplyTo": "<q@me.x>", "from": {"address": "ME@x.com"}}));
        assert!(!replied_in(&c, "INBOX", "<q@me.x>", &own));
        // An address that only contains one of them is someone else.
        put(&c, "a", "INBOX", 3, 3, json!({"uid": 3, "inReplyTo": "<q@me.x>", "from": {"address": "notme@x.com"}}));
        assert!(replied_in(&c, "INBOX", "<q@me.x>", &own));
    }

    #[test]
    fn an_automatic_reply_is_no_reply_by_its_header_or_its_subject() {
        let (_t, c) = store();
        put(&c, "a", "INBOX", 1, 1, json!({"uid": 1, "subject": "Re: Quote", "autoReply": "auto-replied", "inReplyTo": "<q@me.x>", "from": {"address": "ana@y.com"}}));
        put(&c, "a", "INBOX", 2, 2, json!({"uid": 2, "subject": "Automatic reply: Quote", "inReplyTo": "<q@me.x>", "from": {"address": "bo@y.com"}}));
        put(&c, "a", "INBOX", 3, 3, json!({"uid": 3, "subject": "Abwesenheitsnotiz: Angebot", "references": ["<q@me.x>"], "from": {"address": "cy@y.com"}}));
        assert!(!replied_in(&c, "INBOX", "<q@me.x>", &["me@x.com"]));
    }

    #[test]
    fn a_lookalike_id_and_another_accounts_reply_are_no_reply() {
        let (_t, c) = store();
        // `_` is a LIKE wildcard: the prefilter lets this through, the parse does not.
        put(&c, "a", "INBOX", 1, 1, json!({"uid": 1, "inReplyTo": "<qx1@me.x>", "from": {"address": "ana@y.com"}}));
        put(&c, "b", "INBOX", 2, 2, json!({"uid": 2, "inReplyTo": "<q_1@me.x>", "from": {"address": "ana@y.com"}}));
        assert!(!replied_in(&c, "INBOX", "<q_1@me.x>", &["me@x.com"]));
        assert!(!replied_in(&c, "INBOX", "<>", &["me@x.com"]), "an empty id answers nothing");
    }

    #[test]
    fn a_page_stops_at_its_limit_and_says_where_to_go_on() {
        let (_t, c) = store();
        for uid in [3, 7, 9] {
            put(&c, "a", "INBOX", uid, uid as i64, json!({"uid": uid, "from": {"address": "x@y.com"}}));
        }
        let wanted = [ReplyWanted { key: "k".into(), message_id: "<q@me.x>".into(), own: vec!["me@x.com".to_string()] }];
        assert_eq!(reply_scan_page_many(&c, "a", "INBOX", &wanted, 0, 2).unwrap(), ReplyScan { replied: vec![], next_after: Some(7) });
        assert_eq!(reply_scan_page_many(&c, "a", "INBOX", &wanted, 7, 2).unwrap(), ReplyScan { replied: vec![], next_after: None });
    }

    #[test]
    fn auto_reply_subjects_are_known_in_every_app_language() {
        for subject in [
            "Automatic reply: Quote", "AUTO: Quote", "Out of Office AutoReply: Quote", "Automatische Antwort: Angebot",
            "Réponse automatique : Devis", "Respuesta automática: Presupuesto", "Risposta automatica: Preventivo",
            "Resposta automática: Orçamento", "自動応答: 見積もり", "자동 회신: 견적", "自动回复: 报价",
        ] {
            assert!(is_auto_reply_subject(subject), "{subject}");
        }
        for subject in ["Re: Quote", "Autumn plans", "Outing on Friday"] {
            assert!(!is_auto_reply_subject(subject), "{subject}");
        }
    }

    #[test]
    fn sender_clock_reads_the_newest_message_from_the_address_across_accounts() {
        let (_t, c) = store();
        put(&c, "a", "INBOX", 1, ms(2026, 1, 5), json!({"uid": 1, "from": {"address": "bob@example.com"}, "date": "Mon, 05 Jan 2026 12:00:00 -0500"}));
        // Newer, in another account and mailbox, in other case: this one wins.
        put(&c, "b", "Archive", 9, ms(2026, 7, 14), json!({"uid": 9, "from": {"name": "Bob", "address": "Bob@Example.com"}, "date": "Tue, 14 Jul 2026 12:00:00 -0400"}));
        // Newer still, but only mention him: my own Sent copy to him, and an
        // address his is a substring of. The LIKE lets both through.
        put(&c, "a", "Sent", 2, ms(2026, 8, 1), json!({"uid": 2, "from": {"address": "me@example.com"}, "to": [{"address": "bob@example.com"}], "date": "Sat, 01 Aug 2026 12:00:00 +0900"}));
        put(&c, "a", "INBOX", 3, ms(2026, 8, 2), json!({"uid": 3, "from": {"address": "notbob@example.com"}, "date": "Sun, 02 Aug 2026 12:00:00 +0100"}));

        assert_eq!(sender_clock(&c, "BOB@example.com").unwrap(), Some((-240, Some(utc(2026, 7, 14, 16)))));
        assert_eq!(sender_clock(&c, "nobody@example.com").unwrap(), None);
    }

    #[test]
    fn sender_clock_dates_the_offset_by_the_header_not_by_arrival() {
        let (_t, c) = store();
        // Imported in December, written in July: the July instant is the one
        // whose DST season the offset belongs to.
        put(&c, "a", "INBOX", 1, ms(2026, 12, 20), json!({"uid": 1, "from": {"address": "bob@example.com"},
            "date": "Tue, 14 Jul 2026 12:00:00 -0400 (EDT)", "internalDate": "2026-12-20T12:00:00+00:00"}));
        assert_eq!(sender_clock(&c, "bob@example.com").unwrap(), Some((-240, Some(utc(2026, 7, 14, 16)))));

        // A header chrono cannot read still has an offset; its row's sort
        // time is the best date there is.
        put(&c, "a", "INBOX", 2, ms(2026, 12, 21), json!({"uid": 2, "from": {"address": "eve@example.com"}, "date": "sometime +0200"}));
        assert_eq!(sender_clock(&c, "eve@example.com").unwrap(), Some((120, Some(ms(2026, 12, 21)))));
    }

    #[test]
    fn sender_clock_reads_a_graph_rows_message_date_and_says_nothing_for_a_zero_zone() {
        let (_t, c) = store();
        put(&c, "a", "INBOX", 1, ms(2026, 9, 9), json!({"uid": 1, "from": {"address": "carol@example.com"},
            "date": "2026-09-09T00:30:00Z", "messageDate": "Wed, 09 Sep 2026 09:30:00 +0900"}));
        assert_eq!(sender_clock(&c, "carol@example.com").unwrap(), Some((540, Some(utc(2026, 9, 9, 0) + 30 * 60_000))));

        // No Date header fetched: the ISO receive time says nothing.
        put(&c, "a", "INBOX", 2, ms(2026, 9, 9), json!({"uid": 2, "from": {"address": "dave@example.com"}, "date": "2026-09-09T00:30:00Z"}));
        assert_eq!(sender_clock(&c, "dave@example.com").unwrap(), None);

        // Exchange rewrote the newest one to +0000: no guess from an older one.
        put(&c, "a", "INBOX", 3, ms(2026, 3, 1), json!({"uid": 3, "from": {"address": "erin@example.com"}, "date": "Sun, 01 Mar 2026 12:00:00 -0500"}));
        put(&c, "a", "INBOX", 4, ms(2026, 9, 1), json!({"uid": 4, "from": {"address": "erin@example.com"}, "date": "Tue, 01 Sep 2026 12:00:00 +0000"}));
        assert_eq!(sender_clock(&c, "erin@example.com").unwrap(), None);
    }

    /// The search index asks by vault folder name, the header cache is keyed
    /// by mailbox path: every cached mailbox of the account whose folder name
    /// matches answers, and nothing else does.
    #[test]
    fn listed_message_ids_answers_for_the_mailboxes_behind_a_vault_folder() {
        let (_t, c) = store();
        put(&c, "a", "Projects/2026", 1, 1, json!({"uid": 1, "messageId": "<one@x.test>"}));
        put(&c, "a", "Projects/2026", 2, 2, json!({"uid": 2}));
        put(&c, "a", "Projects/2026", 3, 3, json!({"uid": 3, "message_id": "<three@x.test>"}));
        c.execute(
            "INSERT INTO header_cache(account_id,mailbox_path,uid,sort_ms,updated_ms,header_json) VALUES ('a','Projects/2026',4,4,0,'not json')",
            [],
        ).unwrap();
        put(&c, "a", "INBOX", 5, 5, json!({"uid": 5, "messageId": "<inbox@x.test>"}));
        put(&c, "b", "Projects/2026", 6, 6, json!({"uid": 6, "messageId": "<other-account@x.test>"}));

        let got = listed_message_ids(&c, "a", "Projects_2026", &[1, 2, 3, 4, 5, 6, 9]).unwrap();
        let want: HashMap<u32, Option<String>> = [
            (1, Some("<one@x.test>".to_string())),
            (2, None),
            (3, Some("<three@x.test>".to_string())),
            (4, None),
        ]
        .into_iter()
        .collect();
        assert_eq!(got, want, "a row that will not parse is still listed, just without an id");
        assert!(listed_message_ids(&c, "a", "Projects_2026", &[]).unwrap().is_empty());
    }

    #[test]
    fn native_batch_replaces_unbound_or_other_origin_headers() {
        let (_t, c) = store();
        save_headers(&c, "a", "INBOX", &json!({"emails": [{"uid": 1}]}).to_string()).unwrap();
        let proof = json!({"accountId": "a", "mailbox": "INBOX", "uidValidity": 7, "originHash": "origin-A"});
        save_headers(&c, "a", "INBOX", &json!({"nativeIdentity": proof, "nativeExpectedIdentity": null, "emails": [{"uid": 7}]}).to_string()).unwrap();
        let got: Value = serde_json::from_str(&load_headers(&c, "a", "INBOX", None, HeaderOrder::Arrival).unwrap().unwrap()).unwrap();
        assert_eq!(got["totalCached"], 1, "unbound retained rows cannot acquire a fresh batch origin");
        assert_eq!(got["nativeIdentity"], proof);
        let mut other = proof.clone();
        other["originHash"] = json!("origin-B");
        save_headers(&c, "a", "INBOX", &json!({"nativeIdentity": other, "nativeExpectedIdentity": proof, "emails": [{"uid": 8}]}).to_string()).unwrap();
        assert_eq!(uid_set(&c, "a", "INBOX").unwrap(), HashSet::from([8]));
    }

    #[test]
    fn native_batch_does_not_bless_unbound_partial_upserts() {
        let (_t, c) = store();
        let proof = json!({"accountId": "a", "mailbox": "INBOX", "uidValidity": 7, "originHash": "origin-A"});
        save_headers(&c, "a", "INBOX", &json!({"nativeIdentity": proof, "nativeExpectedIdentity": null, "emails": [{"uid": 7}]}).to_string()).unwrap();
        save_headers(&c, "a", "INBOX", &json!({"uidValidity": 8, "emails": [{"uid": 8}]}).to_string()).unwrap();
        let got: Value = serde_json::from_str(&load_meta(&c, "a", "INBOX").unwrap().unwrap()).unwrap();
        assert!(got.get("nativeIdentity").is_none_or(Value::is_null));
    }

    #[test]
    fn native_batch_late_origin_or_generation_cannot_replace_newer_proof() {
        for generation_change in [false, true] {
            let (_t, c) = store();
            let a = json!({"accountId": "a", "mailbox": "INBOX", "uidValidity": 7, "originHash": "origin-A"});
            let mut b = a.clone();
            if generation_change { b["uidValidity"] = json!(8); } else { b["originHash"] = json!("origin-B"); }
            // A observed no bound cache, then B won publication while A waited.
            save_headers(&c, "a", "INBOX", &json!({"nativeIdentity": b, "nativeExpectedIdentity": null, "emails": [{"uid": 8}]}).to_string()).unwrap();
            let before = load_headers(&c, "a", "INBOX", None, HeaderOrder::Arrival).unwrap();
            let late = save_headers(&c, "a", "INBOX", &json!({"nativeIdentity": a, "nativeExpectedIdentity": null, "emails": [{"uid": 7}]}).to_string());
            assert!(late.is_err(), "a late old-identity publication must refuse");
            assert_eq!(load_headers(&c, "a", "INBOX", None, HeaderOrder::Arrival).unwrap(), before);
        }
    }

    #[test]
    fn native_batch_same_identity_pages_merge_but_missing_expectation_cannot_bind_legacy() {
        let (_t, c) = store();
        let proof = json!({"accountId": "a", "mailbox": "INBOX", "uidValidity": 7, "originHash": "origin-A"});
        save_headers(&c, "a", "INBOX", &json!({"emails": [{"uid": 1}]}).to_string()).unwrap();
        assert!(save_headers(&c, "a", "INBOX", &json!({"nativeIdentity": proof, "emails": [{"uid": 7}]}).to_string()).is_err());
        save_headers(&c, "a", "INBOX", &json!({"nativeIdentity": proof, "nativeExpectedIdentity": null, "emails": [{"uid": 7}]}).to_string()).unwrap();
        save_headers(&c, "a", "INBOX", &json!({"nativeIdentity": proof, "nativeExpectedIdentity": null, "emails": [{"uid": 8}]}).to_string()).unwrap();
        assert_eq!(uid_set(&c, "a", "INBOX").unwrap(), HashSet::from([7, 8]));
        patch_flags(&c, "a", "INBOX", &[(7, vec!["\\Seen".into()])]).unwrap();
        let meta: Value = serde_json::from_str(&load_meta(&c, "a", "INBOX").unwrap().unwrap()).unwrap();
        assert_eq!(meta["nativeIdentity"], proof);
    }

    #[test]
    fn native_batch_empty_count_and_repair_paths_preserve_only_proved_rows() {
        let (_t, c) = store();
        let proof = json!({"accountId": "a", "mailbox": "INBOX", "uidValidity": 7, "originHash": "origin-A"});
        save_headers(&c, "a", "INBOX", &json!({"nativeIdentity": proof, "nativeExpectedIdentity": null, "emails": []}).to_string()).unwrap();
        save_headers(&c, "a", "INBOX", &json!({"totalEmails": 2}).to_string()).unwrap();
        let identity = serde_json::from_value(proof.clone()).unwrap();
        assert_eq!(restore_missing_headers_bound(&c, "a", "INBOX", &[json!({"uid": 7, "subject": "original"})], &identity).unwrap(), [7]);
        assert!(restore_missing_headers_bound(&c, "a", "INBOX", &[json!({"uid": 7, "subject": "replacement"})], &identity).unwrap().is_empty());
        let got: Value = serde_json::from_str(&load_headers(&c, "a", "INBOX", None, HeaderOrder::Arrival).unwrap().unwrap()).unwrap();
        assert_eq!(got["nativeIdentity"], proof);
        assert_eq!(got["emails"][0]["subject"], "original");
        restore_missing_headers(&c, "a", "INBOX", &[json!({"uid": 8})]).unwrap();
        let got: Value = serde_json::from_str(&load_meta(&c, "a", "INBOX").unwrap().unwrap()).unwrap();
        assert!(got.get("nativeIdentity").is_none());
        save_headers(&c, "a", "INBOX", &json!({"nativeIdentity": proof, "totalEmails": 2}).to_string()).unwrap();
        let got: Value = serde_json::from_str(&load_meta(&c, "a", "INBOX").unwrap().unwrap()).unwrap();
        assert!(got.get("nativeIdentity").is_none(), "metadata-only observation cannot bind retained rows");
    }

    #[test]
    fn native_batch_empty_prune_retains_only_existing_ownership() {
        let (_temp, conn) = store();
        let proof = json!({"accountId":"a","mailbox":"INBOX","uidValidity":1,"originHash":"original-A"});
        save_headers(&conn, "a", "INBOX", &json!({
            "nativeIdentity":proof,"nativeExpectedIdentity":null,
            "emails":[{"uid":1},{"uid":2},{"uid":3}]
        }).to_string()).unwrap();
        // Exact empty metadata/prune payload emitted by the frontend adapter;
        // no row or current observation is promoted into identity authority.
        save_headers(&conn, "a", "INBOX", &json!({
            "accountId":"a","mailbox":"INBOX","emails":[],"totalEmails":2,
            "uidValidity":null,"uidNext":null,"highestModseq":null,"removedUids":[3]
        }).to_string()).unwrap();
        let meta: Value = serde_json::from_str(&load_meta(&conn, "a", "INBOX").unwrap().unwrap()).unwrap();
        assert_eq!(meta["nativeIdentity"], proof);
        let mut retained = load_by_uids(&conn, "a", "INBOX", &[1, 2, 3]).unwrap()
            .iter().map(|row| row["uid"].as_u64().unwrap()).collect::<Vec<_>>();
        retained.sort_unstable();
        assert_eq!(retained, vec![1, 2]);
        save_headers(&conn, "a", "Unknown", &json!({"emails":[],"removedUids":[3]}).to_string()).unwrap();
        assert!(native_identity(&conn, "a", "Unknown").unwrap().is_none());
        save_headers(&conn, "a", "INBOX", &json!({"nativeIdentity":null,"emails":[{"uid":4}]}).to_string()).unwrap();
        assert!(native_identity(&conn, "a", "INBOX").unwrap().is_none());
    }

    /// H3b (a): a folder with no header row at all (never opened, backfill
    /// not there yet, cleared and refilling, an account's cache wiped) is not
    /// "the server holds none of them": the lookup is unknown, so the index
    /// keeps its rows and nothing reaches the metadata prune.
    #[test]
    fn a_folder_with_no_header_rows_is_unknown_not_empty() {
        let (_t, c) = store();
        put(&c, "a", "INBOX", 5, 5, json!({"uid": 5, "messageId": "<inbox@x.test>"}));
        let unknown = listed_message_ids(&c, "a", "Archive", &[1]).unwrap_err();
        assert!(unknown.starts_with(FOLDER_NOT_LISTED), "{unknown}");
        assert!(listed_message_ids(&c, "z", "INBOX", &[1]).unwrap_err().starts_with(FOLDER_NOT_LISTED));
        // Meta alone (a sync that wrote its counts first) lists nothing either.
        save_headers(&c, "a", "Archive", &json!({"totalEmails": 3, "uidValidity": 1}).to_string()).unwrap();
        assert!(listed_message_ids(&c, "a", "Archive", &[1]).unwrap_err().starts_with(FOLDER_NOT_LISTED));
        clear_headers(&c, Some("a"), Some("INBOX")).unwrap();
        assert!(listed_message_ids(&c, "a", "INBOX", &[5]).unwrap_err().starts_with(FOLDER_NOT_LISTED), "cleared, refilling");
    }

    /// H3b fix 1: a refill lands newest first and evicted mail is old, so a
    /// cache holding fewer rows than the server's count the daemon recorded
    /// (`syncTotalEmails`) cannot say a uid is gone: unknown, until it is
    /// complete. The fresh-index fill waits for it too. With no such count
    /// (a Graph folder, a cache the app wrote) the rows are the listing.
    #[test]
    fn a_partly_refilled_folder_is_unknown_until_its_cache_is_complete() {
        let (_t, c) = store();
        let row = |uid: u32| json!({"uid": uid, "messageId": format!("<{uid}@x.test>")});
        save_headers(&c, "a", "INBOX", &json!({"syncTotalEmails": 3, "emails": [row(3)]}).to_string()).unwrap();
        let partial = listed_message_ids(&c, "a", "INBOX", &[1, 3]).unwrap_err();
        assert!(partial.starts_with(FOLDER_NOT_LISTED), "{partial}");
        assert!(folder_headers(&c, "a", "INBOX").unwrap_err().starts_with(FOLDER_NOT_LISTED), "the fill waits");
        let shared: crate::custody::SharedConn = std::sync::Mutex::new(Some(c));
        assert!(listed_message_ids_shared(&shared, "a", "INBOX", &[1, 3]).unwrap_err().starts_with(FOLDER_NOT_LISTED));
        let c = crate::custody::lock(&shared).take().unwrap();

        save_headers(&c, "a", "INBOX", &json!({"emails": [row(2), row(1)]}).to_string()).unwrap();
        assert_eq!(listed_message_ids(&c, "a", "INBOX", &[1, 3, 4]).unwrap().len(), 2, "complete: 4 is not on the server");
        assert_eq!(folder_headers(&c, "a", "INBOX").unwrap().len(), 3);

        put(&c, "a", "Archive", 1, 1, row(1));
        assert_eq!(listed_message_ids(&c, "a", "Archive", &[1, 2]).unwrap().len(), 1, "no recorded count: the rows decide");
    }

    /// I3: the app fetches arrivals past the daemon's `syncUidNext`, which its
    /// `syncTotalEmails` never counted. Those rows must not make up for old
    /// rows a backfill has not reached yet: only uids below `syncUidNext` are
    /// judged against the count, as the app's own tally does.
    #[test]
    fn app_fetched_arrivals_do_not_complete_a_partial_backfill() {
        let (_t, c) = store();
        let rows = |uids: &[u32]| json!(uids.iter().map(|u| json!({"uid": u, "messageId": format!("<{u}@x.test>")})).collect::<Vec<_>>());
        save_headers(&c, "a", "INBOX", &json!({"syncTotalEmails": 3, "syncUidNext": 10, "emails": rows(&[2, 3])}).to_string()).unwrap();
        save_headers(&c, "a", "INBOX", &json!({"emails": rows(&[10, 11])}).to_string()).unwrap();
        let partial = listed_message_ids(&c, "a", "INBOX", &[1, 2]).unwrap_err();
        assert!(partial.starts_with(FOLDER_NOT_LISTED), "4 rows, but 2 of the 3 the daemon counted: {partial}");
        assert!(folder_headers(&c, "a", "INBOX").unwrap_err().starts_with(FOLDER_NOT_LISTED));

        save_headers(&c, "a", "INBOX", &json!({"emails": rows(&[1])}).to_string()).unwrap();
        assert_eq!(listed_message_ids(&c, "a", "INBOX", &[1, 2, 4]).unwrap().len(), 2, "complete: 4 is not on the server");
        assert_eq!(folder_headers(&c, "a", "INBOX").unwrap().len(), 5, "arrivals are still read");
    }

    /// H3b fix 2: a folder the server says is empty (the daemon recorded a
    /// count of 0, and no row is left: Empty Trash, the last message deleted)
    /// is a verified empty listing, so the index drops its fileless rows.
    #[test]
    fn a_folder_the_server_counts_empty_is_a_verified_empty_listing() {
        let (_t, c) = store();
        save_headers(&c, "a", "Trash", &json!({"syncTotalEmails": 2, "emails": [{"uid": 1}, {"uid": 2}]}).to_string()).unwrap();
        save_headers(&c, "a", "Trash", &json!({"syncTotalEmails": 0, "removedUids": [1, 2]}).to_string()).unwrap();
        assert_eq!(listed_message_ids(&c, "a", "Trash", &[1, 2]).unwrap(), HashMap::new());
        assert!(folder_headers(&c, "a", "Trash").unwrap().is_empty());
        let shared: crate::custody::SharedConn = std::sync::Mutex::new(Some(c));
        assert_eq!(listed_message_ids_shared(&shared, "a", "Trash", &[1]).unwrap(), HashMap::new());
    }

    fn meta_u64(c: &Connection, mailbox: &str, key: &str) -> Option<u64> {
        load_meta(c, "a", mailbox).unwrap().and_then(|m| serde_json::from_str::<Value>(&m).ok()?.get(key)?.as_u64())
    }

    /// H3b round 3 (N1, option c): the app's delete, move or Empty Trash sends
    /// only `removedUids`. `syncTotalEmails` is the daemon's expunge-gate
    /// baseline and only the daemon writes it, so the app's removals are
    /// counted apart (`appRemovedSinceSync`, the rows taken on balance, below
    /// the daemon's `syncUidNext`) and the listing is judged against the
    /// difference: the deleted mail reads as gone at once, Empty Trash is a
    /// verified empty listing, a re-key nets zero, an arrival the daemon never
    /// counted is not counted either, and Graph gets no key.
    #[test]
    fn an_app_removal_is_counted_apart_from_the_daemons_server_count() {
        let (_t, c) = store();
        let rows = |uids: &[u32]| json!(uids.iter().map(|u| json!({"uid": u, "messageId": format!("<{u}@x.test>")})).collect::<Vec<_>>());
        let app_removed = |c: &Connection| meta_u64(c, "INBOX", APP_REMOVED_SINCE_SYNC);
        save_headers(&c, "a", "INBOX", &json!({"syncTotalEmails": 3, "syncUidNext": 10, "emails": rows(&[1, 2, 3])}).to_string()).unwrap();

        save_headers(&c, "a", "INBOX", &json!({"removedUids": [2, 99]}).to_string()).unwrap();
        assert_eq!(meta_u64(&c, "INBOX", "syncTotalEmails"), Some(3), "the daemon's baseline is never moved by the app");
        assert_eq!(app_removed(&c), Some(1), "one row went; 99 was never listed");
        assert_eq!(listed_message_ids(&c, "a", "INBOX", &[1, 2, 3]).unwrap().len(), 2, "complete: 2 reads as gone");

        save_headers(&c, "a", "INBOX", &json!({"emails": rows(&[7, 8]), "removedUids": [1, 3]}).to_string()).unwrap();
        assert_eq!(app_removed(&c), Some(1), "a re-key removes as many as it adds");

        save_headers(&c, "a", "INBOX", &json!({"emails": rows(&[12])}).to_string()).unwrap();
        save_headers(&c, "a", "INBOX", &json!({"removedUids": [12]}).to_string()).unwrap();
        assert_eq!(app_removed(&c), Some(1), "an arrival at or above syncUidNext was never in the baseline");

        save_headers(&c, "a", "INBOX", &json!({"removedUids": [7, 8]}).to_string()).unwrap();
        assert_eq!(app_removed(&c), Some(3));
        assert_eq!(listed_message_ids(&c, "a", "INBOX", &[7, 8]).unwrap(), HashMap::new(), "Empty Trash: verified empty");
        assert_eq!(meta_u64(&c, "INBOX", "syncTotalEmails"), Some(3));

        // The daemon's sync writes a fresh count and resets the app's tally with it.
        save_headers(&c, "a", "INBOX", &json!({"syncTotalEmails": 0, APP_REMOVED_SINCE_SYNC: 0}).to_string()).unwrap();
        assert_eq!(app_removed(&c), Some(0));
        assert_eq!(listed_message_ids(&c, "a", "INBOX", &[7]).unwrap(), HashMap::new());

        save_headers(&c, "a", "Graph", &json!({"totalEmails": 2, "emails": rows(&[1, 2])}).to_string()).unwrap();
        save_headers(&c, "a", "Graph", &json!({"removedUids": [1]}).to_string()).unwrap();
        assert_eq!(meta_u64(&c, "Graph", APP_REMOVED_SINCE_SYNC), None, "no daemon count: nothing to offset");

        // Without a recorded syncUidNext every row counts.
        save_headers(&c, "a", "Sent", &json!({"syncTotalEmails": 2, "emails": rows(&[1, 2])}).to_string()).unwrap();
        save_headers(&c, "a", "Sent", &json!({"removedUids": [2]}).to_string()).unwrap();
        assert_eq!(meta_u64(&c, "Sent", APP_REMOVED_SINCE_SYNC), Some(1));
    }

    /// A miss in the rows proves absence only when they are the whole mailbox
    /// as the server has it right now: the sync's own count is in, every row
    /// it covers is cached, and the generation and UIDNEXT it recorded are the
    /// ones a SELECT just gave (a later APPEND, ours or anyone's, moves UIDNEXT).
    #[test]
    fn a_mailbox_is_whole_only_when_complete_and_nothing_arrived_since_its_sync() {
        let (_t, c) = store();
        let rows = |uids: &[u32]| json!(uids.iter().map(|u| json!({"uid": u, "messageId": format!("<{u}@x.test>")})).collect::<Vec<_>>());
        let whole = |c: &Connection, mailbox: &str| lists_whole_mailbox(c, "a", mailbox, 7, 4).unwrap();
        save_headers(&c, "a", "INBOX", &json!({"uidValidity": 7, "syncTotalEmails": 3, "syncUidNext": 4, "emails": rows(&[1, 2, 3])}).to_string()).unwrap();
        assert!(whole(&c, "INBOX"), "complete, same generation, same UIDNEXT");
        assert!(!lists_whole_mailbox(&c, "a", "INBOX", 7, 5).unwrap(), "a message arrived after the sync");
        assert!(!lists_whole_mailbox(&c, "a", "INBOX", 8, 4).unwrap(), "another generation");

        save_headers(&c, "a", "Partial", &json!({"uidValidity": 7, "syncTotalEmails": 3, "syncUidNext": 4, "emails": rows(&[3])}).to_string()).unwrap();
        assert!(!whole(&c, "Partial"), "a refill part way");

        save_headers(&c, "a", "AppOnly", &json!({"uidValidity": 7, "uidNext": 4, "emails": rows(&[1, 2, 3])}).to_string()).unwrap();
        assert!(!whole(&c, "AppOnly"), "no daemon count: the rows may be any subset");

        save_headers(&c, "a", "Empty", &json!({"uidValidity": 7, "syncTotalEmails": 0, "syncUidNext": 4}).to_string()).unwrap();
        assert!(whole(&c, "Empty"), "counted empty and nothing arrived since");
        assert!(!whole(&c, "Never"), "never synced");
    }

    /// The hole heal writes only what is missing: a row written since the
    /// heal's fetch (the app's, a sync's) is newer and stays, and the meta,
    /// the app's tally included, is left exactly as it was.
    #[test]
    fn a_restore_fills_only_missing_rows_and_leaves_the_meta_alone() {
        let (_t, c) = store();
        let row = |uid: u32, subject: &str| json!({"uid": uid, "subject": subject});
        save_headers(&c, "a", "INBOX", &json!({"syncTotalEmails": 3, "syncUidNext": 10, "emails": [row(1, "one"), row(2, "two"), row(3, "three")]}).to_string()).unwrap();
        save_headers(&c, "a", "INBOX", &json!({"removedUids": [2]}).to_string()).unwrap();
        // The stored blob itself: `load_meta` adds the live row count.
        let stored_meta = |c: &Connection| -> String {
            c.query_row("SELECT meta_json FROM header_cache_meta WHERE account_id='a' AND mailbox_path='INBOX'", [], |r| r.get(0)).unwrap()
        };
        let meta_before = stored_meta(&c);

        let restored = restore_missing_headers(&c, "a", "INBOX", &[row(2, "two again"), row(3, "stale three"), json!({"no": "uid"})]).unwrap();

        assert_eq!(restored, vec![2]);
        let rows = load_by_uids(&c, "a", "INBOX", &[2, 3]).unwrap();
        let subject = |uid: u64| rows.iter().find(|r| r["uid"] == uid).map(|r| r["subject"].clone());
        assert_eq!(subject(2), Some(json!("two again")));
        assert_eq!(subject(3), Some(json!("three")), "an existing row is never overwritten");
        assert_eq!(stored_meta(&c), meta_before, "no count, tally or stamp moves");
        assert_eq!(meta_u64(&c, "INBOX", APP_REMOVED_SINCE_SYNC), Some(1));
    }

    /// The daemon's lookup takes the custody lock per chunk, so a big evicted
    /// folder never holds sync writes for the whole walk; it answers exactly
    /// what the single-connection lookup does, and a closed store is an error.
    #[test]
    fn the_shared_lookup_answers_like_the_plain_one_across_chunks() {
        let (_t, mut c) = store();
        let tx = c.transaction().unwrap();
        for uid in 1..=2_000u32 {
            let id = if uid % 7 == 0 { json!(null) } else { json!(format!("<{uid}@x.test>")) };
            tx.execute(
                "INSERT INTO header_cache(account_id,mailbox_path,uid,sort_ms,updated_ms,header_json) VALUES ('a','Projects/2026',?1,0,0,?2)",
                params![uid, json!({"uid": uid, "messageId": id}).to_string()],
            ).unwrap();
        }
        tx.commit().unwrap();
        let uids: Vec<u32> = (1..=2_500).collect();
        let plain = listed_message_ids(&c, "a", "Projects_2026", &uids).unwrap();
        assert_eq!(plain.len(), 2_000);
        let shared: crate::custody::SharedConn = std::sync::Mutex::new(Some(c));
        assert_eq!(listed_message_ids_shared(&shared, "a", "Projects_2026", &uids).unwrap(), plain);
        assert!(listed_message_ids_shared(&shared, "a", "Archive", &uids).unwrap_err().starts_with(FOLDER_NOT_LISTED));
        assert!(listed_message_ids_shared(&shared, "a", "Projects_2026", &[]).unwrap().is_empty());
        *crate::custody::lock(&shared) = None;
        assert!(listed_message_ids_shared(&shared, "a", "Projects_2026", &uids).is_err(), "closed: unknown, never empty");
    }

    /// What a fresh index adds header-only rows from: every cached header of
    /// every mailbox behind the vault folder; an unknown folder has none.
    #[test]
    fn folder_headers_reads_every_mailbox_behind_a_vault_folder() {
        let (_t, c) = store();
        put(&c, "a", "Projects/2026", 1, 1, json!({"uid": 1, "subject": "One"}));
        put(&c, "a", "Projects_2026", 2, 2, json!({"uid": 2, "subject": "Two"}));
        put(&c, "a", "INBOX", 3, 3, json!({"uid": 3}));
        put(&c, "b", "Projects/2026", 4, 4, json!({"uid": 4}));
        let mut uids: Vec<u64> = folder_headers(&c, "a", "Projects_2026").unwrap().iter().map(|h| h["uid"].as_u64().unwrap()).collect();
        uids.sort_unstable();
        assert_eq!(uids, vec![1, 2]);
        assert!(folder_headers(&c, "a", "Archive").unwrap().is_empty());
    }

    /// A star from a board card or a reader's delayed mark read moves only
    /// its flag in the cached header: the read state, the star and keywords
    /// the vault file cannot hold all stay.
    #[test]
    fn a_delta_keeps_every_other_flag_of_the_cached_header() {
        let (_t, c) = store();
        put(&c, "a", "INBOX", 1, 1, json!({"uid": 1, "subject": "One", "flags": ["\\Seen", "$Forwarded"]}));
        put(&c, "a", "INBOX", 2, 2, json!({"uid": 2, "flags": ["\\Flagged"]}));
        let delta = |uid, flag: &str, on| FlagChange { uid, flags: vec![flag.to_string()], on: Some(on) };
        assert_eq!(patch_changes(&c, "a", "INBOX", &[delta(1, "\\Flagged", true), delta(2, "\\Seen", true)]).unwrap(), 2);
        let flags = |uid: u32| -> Value {
            let text: String = c.query_row("SELECT header_json FROM header_cache WHERE uid=?1", [uid], |r| r.get(0)).unwrap();
            serde_json::from_str::<Value>(&text).unwrap()["flags"].clone()
        };
        assert_eq!(flags(1), json!(["\\Seen", "$Forwarded", "\\Flagged"]));
        assert_eq!(flags(2), json!(["\\Flagged", "\\Seen"]));
        assert_eq!(patch_changes(&c, "a", "INBOX", &[delta(1, "\\Flagged", true)]).unwrap(), 0, "already on: no write");
        // The server's whole list still replaces it.
        assert_eq!(patch_flags(&c, "a", "INBOX", &[(1, vec![])]).unwrap(), 1);
        assert_eq!(flags(1), json!([]));
    }

    #[test]
    fn month_histogram_is_empty_for_an_unknown_mailbox() {
        let (_t, c) = store();
        insert(&c, "a", "INBOX", 1, ms(2021, 3, 1));
        assert_eq!(month_histogram(&c, "a", "Archive").unwrap(), json!([]));
        assert_eq!(month_histogram(&c, "z", "INBOX").unwrap(), json!([]));
    }

    // ── Phase 5: the pieces the vault-gap count walks the cache with ──

    /// Pages by uid, ascending, from just past `after`: every row once, none
    /// skipped at a page edge, nothing of another mailbox or account. A page
    /// by `sort_ms` or with `>=` would repeat or lose the edge row.
    #[test]
    fn uid_dates_after_pages_every_row_once_by_uid() {
        let (_t, c) = store();
        // Inserted out of order, dates unrelated to uids.
        for (uid, sort_ms) in [(7, 70), (2, 900), (5, -3), (1, 10), (6, 60), (3, 30), (4, 40)] {
            insert(&c, "a", "INBOX", uid, sort_ms);
        }
        insert(&c, "a", "Archive", 8, 80);
        insert(&c, "b", "INBOX", 9, 90);

        assert_eq!(uid_dates_after(&c, "a", "INBOX", None, 3).unwrap(), vec![(1, 10), (2, 900), (3, 30)]);
        assert_eq!(uid_dates_after(&c, "a", "INBOX", Some(3), 3).unwrap(), vec![(4, 40), (5, -3), (6, 60)]);
        assert_eq!(uid_dates_after(&c, "a", "INBOX", Some(6), 3).unwrap(), vec![(7, 70)]);
        assert!(uid_dates_after(&c, "a", "INBOX", Some(7), 3).unwrap().is_empty());
        assert!(uid_dates_after(&c, "a", "Sent", None, 3).unwrap().is_empty());
    }

    /// One seek per step, in name order, each mailbox once however many rows
    /// it holds; another account's mailboxes never appear.
    #[test]
    fn next_mailbox_with_headers_steps_through_each_mailbox_once() {
        let (_t, c) = store();
        for uid in 1..=5 {
            insert(&c, "a", "INBOX", uid, 0);
        }
        insert(&c, "a", "Archive", 1, 0);
        insert(&c, "a", "A/B", 1, 0);
        insert(&c, "b", "Zeta", 1, 0);

        let mut seen = Vec::new();
        let mut after: Option<String> = None;
        while let Some(m) = next_mailbox_with_headers(&c, "a", after.as_deref()).unwrap() {
            seen.push(m.clone());
            after = Some(m);
        }
        assert_eq!(seen, vec!["A/B", "Archive", "INBOX"]);
        assert_eq!(next_mailbox_with_headers(&c, "nobody", None).unwrap(), None);
    }

    /// A folder the sync counted whose rows are gone still has its meta row:
    /// the meta list names it, the row walk cannot.
    #[test]
    fn mailboxes_with_meta_names_a_counted_folder_that_holds_no_row() {
        let (_t, c) = store();
        save_headers(&c, "a", "INBOX", r#"{"emails": [{"uid": 1}], "syncTotalEmails": 1}"#).unwrap();
        save_headers(&c, "a", "Wiped", r#"{"emails": [], "syncTotalEmails": 5, "syncUidNext": 6}"#).unwrap();
        save_headers(&c, "b", "Other", r#"{"emails": []}"#).unwrap();
        let mut got = mailboxes_with_meta(&c, "a").unwrap();
        got.sort();
        assert_eq!(got, vec!["INBOX", "Wiped"]);
        assert_eq!(next_mailbox_with_headers(&c, "a", Some("INBOX")).unwrap(), None, "no row walk reaches Wiped");
    }

    /// A header row, a folder's meta alone (a synced empty folder) or a folder
    /// list alone each make the account known; nothing makes it unknown.
    #[test]
    fn knows_account_by_a_row_a_meta_or_a_folder_list() {
        let (_t, c) = store();
        assert!(!knows_account(&c, "a").unwrap());
        insert(&c, "a", "INBOX", 1, 0);
        assert!(knows_account(&c, "a").unwrap());

        save_headers(&c, "m", "INBOX", r#"{"emails": [], "syncTotalEmails": 0}"#).unwrap();
        assert!(knows_account(&c, "m").unwrap());

        save_mailboxes(&c, "f", r#"{"mailboxes": []}"#).unwrap();
        assert!(knows_account(&c, "f").unwrap());
        assert!(!knows_account(&c, "ghost").unwrap());
    }

    /// The daemon's count less the app's removals, and its UIDNEXT; nothing
    /// recorded reads as `(None, None)`, never as zero.
    #[test]
    fn recorded_count_is_the_sync_count_less_what_the_app_removed() {
        let (_t, c) = store();
        save_headers(&c, "a", "INBOX", r#"{"emails": [], "syncTotalEmails": 10, "syncUidNext": 50, "appRemovedSinceSync": 3}"#).unwrap();
        assert_eq!(recorded_count(&c, "a", "INBOX").unwrap(), (Some(7), Some(50)));
        save_headers(&c, "a", "Sent", r#"{"emails": [], "uidValidity": 1}"#).unwrap();
        assert_eq!(recorded_count(&c, "a", "Sent").unwrap(), (None, None));
        assert_eq!(recorded_count(&c, "a", "Nowhere").unwrap(), (None, None));
    }

    mod message_addr_hooks {
        use super::*;
        use crate::custody::db;
        use crate::people::message_addr as ma;

        fn open() -> (tempfile::TempDir, Connection) {
            let t = tempfile::tempdir().unwrap();
            let c = db::open(t.path()).unwrap();
            (t, c)
        }
        fn count(c: &Connection) -> i64 { c.query_row("SELECT count(*) FROM message_addr", [], |r| r.get(0)).unwrap() }
        fn emails(uids: &[u32]) -> String {
            let rows: Vec<Value> = uids.iter().map(|u| json!({"uid": u, "date": "2024-01-02T03:04:05Z", "from": {"address": format!("s{u}@x.io")}, "to": [{"address": "me@h.io"}]})).collect();
            json!({"emails": rows}).to_string()
        }

        #[test]
        fn save_adds_and_removed_uids_forget() {
            let (_t, c) = open();
            save_headers(&c, "a", "INBOX", &emails(&[1, 2, 3])).unwrap();
            assert_eq!(count(&c), 6);
            save_headers(&c, "a", "INBOX", &json!({"removedUids": [2]}).to_string()).unwrap();
            assert_eq!(count(&c), 4);
        }

        #[test]
        fn remove_prune_clear_and_rename_keep_it_in_step() {
            let (_t, c) = open();
            save_headers(&c, "a", "INBOX", &emails(&[1, 2, 3, 4])).unwrap();
            remove_headers(&c, "a", "INBOX", &[1]).unwrap();
            assert_eq!(count(&c), 6);
            prune_headers(&c, "a", "INBOX", &[2, 3]).unwrap();
            assert_eq!(count(&c), 4);
            rename_mailbox(&c, "a", "INBOX", "Trash").unwrap();
            let counted: i64 = c.query_row("SELECT max(counted) FROM message_addr", [], |r| r.get(0)).unwrap();
            assert_eq!(counted, 0);
            clear_headers(&c, Some("a"), Some("Trash")).unwrap();
            assert_eq!(count(&c), 0);
        }

        #[test]
        fn renaming_onto_a_mailbox_that_has_uids_leaves_no_stale_rows_for_the_replaced_ones() {
            let (_t, c) = open();
            let trash = json!({"emails": [
                {"uid": 1, "date": "2024-01-02T03:04:05Z", "from": {"address": "old@x.io"}},
                {"uid": 9, "date": "2024-01-02T03:04:05Z", "from": {"address": "kept@x.io"}},
            ]}).to_string();
            save_headers(&c, "a", "Trash", &trash).unwrap();
            save_headers(&c, "a", "INBOX", &emails(&[1])).unwrap();
            rename_mailbox(&c, "a", "INBOX", "Trash").unwrap();
            let addrs = |uid: u32| -> Vec<String> {
                c.prepare("SELECT address FROM message_addr WHERE mailbox_path='Trash' AND uid=?1 AND role='from'").unwrap()
                    .query_map([uid], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
            };
            assert_eq!(addrs(1), ["s1@x.io"], "the replaced uid keeps only the moved message's addresses");
            assert_eq!(addrs(9), ["kept@x.io"], "a uid the move did not touch keeps its rows");
        }

        #[test]
        fn rewriting_an_identical_header_does_not_redo_the_index_work() {
            let (_t, c) = open();
            save_headers(&c, "a", "INBOX", &emails(&[1, 2])).unwrap();
            // knock a row out behind the hook's back; an identical re-save must not resurrect it
            c.execute("DELETE FROM message_addr WHERE uid=1", []).unwrap();
            save_headers(&c, "a", "INBOX", &emails(&[1, 2])).unwrap();
            let n: i64 = c.query_row("SELECT count(*) FROM message_addr WHERE uid=1", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 0, "identical header_json is skipped");
            // a changed header IS re-indexed
            let changed = json!({"emails": [{"uid": 1, "date": "2024-01-02T03:04:05Z", "from": {"address": "other@x.io"}}]}).to_string();
            save_headers(&c, "a", "INBOX", &changed).unwrap();
            let a: String = c.query_row("SELECT address FROM message_addr WHERE uid=1 AND role='from'", [], |r| r.get(0)).unwrap();
            assert_eq!(a, "other@x.io");
        }

        #[test]
        #[ignore = "perf budget; run with --ignored on the runner"]
        fn the_hook_adds_little_to_a_5k_row_save() {
            let (_t, c) = open();
            let uids: Vec<u32> = (1..=5000).collect();
            let data = emails(&uids);
            let t0 = std::time::Instant::now();
            save_headers(&c, "a", "INBOX", &data).unwrap();
            let first = t0.elapsed();
            let t1 = std::time::Instant::now();
            save_headers(&c, "a", "INBOX", &data).unwrap();
            let again = t1.elapsed();
            eprintln!("first save {first:?}, identical re-save {again:?}");
            assert!(again < first, "an identical re-save is cheaper than the first");
            assert!(first < std::time::Duration::from_secs(5), "first save took {first:?}");
        }

        #[test]
        fn restore_missing_indexes_only_what_it_wrote() {
            let (_t, c) = open();
            save_headers(&c, "a", "INBOX", &emails(&[1])).unwrap();
            let rows: Vec<Value> = serde_json::from_str::<Value>(&emails(&[1, 2])).unwrap()["emails"].as_array().unwrap().clone();
            let wrote = restore_missing_headers(&c, "a", "INBOX", &rows).unwrap();
            assert_eq!(wrote, vec![2]);
            assert_eq!(count(&c), 4);
            let _ = ma::normalize("x@y.z");
        }
    }
}
