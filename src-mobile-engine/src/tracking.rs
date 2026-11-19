//! What this phone has found in the way of tracking pixels: `mobile.tracking.stats`, the phone's
//! half of the "what this install found" section of desktop's Settings > Privacy > Tracking
//! (desktop counts its `trackerAlerts`, one entry per message whose body it scanned).
//!
//! Every body the engine stores is scanned for pixels with core's `body_scan`. A message the user
//! opens (fetched then, or a download's body opened later) with at least one pixel leaves its
//! verdict here, in the write that stores or stamps its body: `acct.<accountId>.trackers.<message>`
//! = `{"n": pixels, "v": [vendor, ...]}` in `settings` (no table of its own, like `usage.rs`; every
//! row goes with the account). Keyed by the message itself, as desktop keys its entries: core's
//! message key (`app_db::identity::msg_key_or_remote`, the key tags and fields use), its
//! Message-ID, else its server id (Graph, JMAP), else its place. So a body fetched again
//! (evicted, refreshed) or a message moved to another folder counts once, and a uid reused for
//! another message (a new UIDVALIDITY, a local uid handed out again) never takes over the old
//! one's verdict. The verdict outlives the cached body and the message: what was found stays
//! found, as on desktop. Counts describe what was FOUND, never what was blocked
//! (a free user's pixels are found and kept), and only in messages opened, as the page's sentence
//! says: a body the offline download fetched and nobody opened is not counted.
//!
//! Opened bodies cached before this tally existed are counted once from their stored scan
//! ([`backfill`], on the first `stats` call; marked by [`BACKFILLED`]).
//!
//! `mobile.tracking.stats {}` -> `{messages, pixels, top: [[vendor, n]], patterns}`: messages with
//! at least one pixel, the pixels in them, the five vendors found in the most messages (most first,
//! then by name), and the size of the bundled endpoint table.

use crate::db::{Engine, Shared};
use crate::rpc::RpcError;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};

/// The `settings` mark of the one-time count of bodies cached before the tally.
pub(crate) const BACKFILLED: &str = "engine.trackerTallyBackfilled.v1";
/// Vendors the page lists.
const TOP: usize = 5;
/// Rows one backfill transaction writes.
const BATCH: usize = 200;

/// The verdict's key for message `uid` of `folder` (see the module): core's message key.
fn key(c: &Connection, account: &str, folder: &str, uid: i64) -> rusqlite::Result<String> {
    let found: Option<(Option<String>, Option<String>)> = c
        .query_row(
            "SELECT m.message_id, r.remote_id FROM messages m
             LEFT JOIN remote_ids r ON r.account_id = m.account_id AND r.folder = m.folder AND r.uid = m.uid
             WHERE m.account_id = ?1 AND m.folder = ?2 AND m.uid = ?3",
            (account, folder, uid),
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (mid, remote) = found.unwrap_or_default();
    let dir = mailvault_core::search_index::text::vault_dir_name(folder);
    let k = mailvault_core::app_db::identity::msg_key_or_remote(mid.as_deref(), &dir, uid as u32, remote.as_deref());
    Ok(format!("acct.{account}.trackers.{k}"))
}

/// Records a stored body's verdict (inside the caller's write). Nothing for a body without pixels.
pub(crate) fn record<'a>(c: &Connection, account: &str, folder: &str, uid: i64, vendors: impl Iterator<Item = &'a str>, pixels: u32) -> rusqlite::Result<()> {
    if pixels == 0 {
        return Ok(());
    }
    let vendors: BTreeSet<&str> = vendors.filter(|v| !v.trim().is_empty()).collect();
    let value = json!({ "n": pixels, "v": vendors }).to_string();
    crate::settings::put_in(c, &key(c, account, folder, uid)?, &value)
}

/// Counts the opened bodies (`last_access_ms` stamped) cached before the tally, once (from
/// `parts_json`'s `trackers` and `trackerList`), at most [`BATCH`] rows per write. A verdict already there is left alone.
fn backfill(shared: &Shared) -> Result<(), String> {
    let done = shared.read(|c| crate::settings::get_in(c, BACKFILLED)).map_err(|e| e.to_string())?;
    if done.is_some() {
        return Ok(());
    }
    let found: Vec<(String, String, i64, u32, Vec<String>)> = shared
        .read(|c| {
            let mut st = c.prepare("SELECT account_id, folder, uid, parts_json FROM bodies WHERE parts_json IS NOT NULL AND last_access_ms > 0")?;
            let rows = st
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter_map(|(a, f, u, parts)| {
            let v: Value = serde_json::from_str(&parts).ok()?;
            let n = v.get("trackers").and_then(Value::as_u64).filter(|n| *n > 0)? as u32;
            let vendors = v
                .get("trackerList")
                .and_then(Value::as_array)
                .map(|l| l.iter().filter_map(|t| t.get("vendor").and_then(Value::as_str).map(str::to_string)).collect())
                .unwrap_or_default();
            Some((a, f, u, n, vendors))
        })
        .collect();
    for chunk in found.chunks(BATCH) {
        shared
            .write(|c| {
                for (a, f, u, n, vendors) in chunk {
                    if crate::settings::get_in(c, &key(c, a, f, *u)?)?.is_none() {
                        record(c, a, f, *u, vendors.iter().map(String::as_str), *n)?;
                    }
                }
                Ok(())
            })
            .map_err(|e| e.to_string())?;
    }
    shared.write(|c| crate::settings::put_in(c, BACKFILLED, "1")).map_err(|e| e.to_string())
}

pub(crate) fn stats(engine: &Engine, _: Value) -> Result<Value, RpcError> {
    let shared = engine.shared();
    // A failed backfill only leaves older bodies uncounted; the tally itself still answers.
    if let Err(e) = backfill(shared) {
        shared.log(&format!("[tracking] backfill: {e}"));
    }
    let values: Vec<String> = shared
        .read(|c| {
            let mut st = c.prepare("SELECT value FROM settings WHERE key LIKE 'acct.%.trackers.%' AND value IS NOT NULL")?;
            let rows = st.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .map_err(|e| RpcError::Internal(e.to_string()))?;
    let (mut messages, mut pixels) = (0u64, 0u64);
    let mut vendors: HashMap<String, u64> = HashMap::new();
    for v in values.iter().filter_map(|s| serde_json::from_str::<Value>(s).ok()) {
        let n = v.get("n").and_then(Value::as_u64).unwrap_or(0);
        if n == 0 {
            continue;
        }
        messages += 1;
        pixels += n;
        for name in v.get("v").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            *vendors.entry(name.to_string()).or_default() += 1;
        }
    }
    let mut top: Vec<(String, u64)> = vendors.into_iter().collect();
    top.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    top.truncate(TOP);
    Ok(json!({
        "messages": messages,
        "pixels": pixels,
        "top": top.into_iter().map(|(v, n)| json!([v, n])).collect::<Vec<_>>(),
        "patterns": mailvault_core::body_scan::tracker_pattern_count(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MemorySecrets;
    use std::sync::Arc;

    fn row(e: &Engine, uid: i64, mid: &str) {
        e.write(|c| {
            c.execute(
                "INSERT INTO messages (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged, has_attachments, to_json, thread_json, message_id)
                 VALUES ('acc', 'INBOX', ?1, 's', 'n', 'a@x', 0, '', 0, 0, 0, '[]', '{}', ?2)",
                rusqlite::params![uid, mid],
            )
        })
        .unwrap();
    }

    /// A uid handed to another message (a new UIDVALIDITY, a local uid reused) keeps the old
    /// message's verdict apart from the new one's; the same message opened in another folder
    /// counts once.
    #[test]
    fn a_verdict_belongs_to_the_message_not_its_uid() {
        let tmp = tempfile::tempdir().unwrap();
        let e = Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(MemorySecrets::default())).unwrap();
        e.write(|c| c.execute("INSERT INTO accounts (id, email, display_name, imap_host, imap_port, security, kind, auth, needs_auth, created_ms) VALUES ('acc', 'me@x', '', 'h', 993, 'ssl', 'imap', 'password', 0, 1)", [])).unwrap();
        row(&e, 7, "<a@x>");
        e.write(|c| record(c, "acc", "INBOX", 7, ["Pixel A"].into_iter(), 2)).unwrap();
        // Uid 7 now names another message.
        e.write(|c| c.execute("DELETE FROM messages WHERE uid = 7", [])).unwrap();
        row(&e, 7, "<b@x>");
        e.write(|c| record(c, "acc", "INBOX", 7, ["Pixel B"].into_iter(), 1)).unwrap();
        let s = stats(&e, json!({})).unwrap();
        assert_eq!((s["messages"].clone(), s["pixels"].clone()), (json!(2), json!(3)), "{s}");
        // Message b, moved to Archive and opened there: still one message.
        e.write(|c| c.execute("UPDATE messages SET folder = 'Archive' WHERE uid = 7", [])).unwrap();
        e.write(|c| record(c, "acc", "Archive", 7, ["Pixel B"].into_iter(), 1)).unwrap();
        assert_eq!(stats(&e, json!({})).unwrap()["messages"], 2);
    }
}
