//! What this phone has found in the way of tracking pixels: `mobile.tracking.stats`, the phone's
//! half of the "what this install found" section of desktop's Settings > Privacy > Tracking
//! (desktop counts its `trackerAlerts`, one entry per message whose body it scanned).
//!
//! Every body the engine stores is scanned for pixels with core's `body_scan`. A message the user
//! opens (fetched then, or a download's body opened later) with at least one pixel leaves its
//! verdict here, in the write that stores or stamps its body: `acct.<accountId>.trackers.<folder>\n<uid>` =
//! `{"n": pixels, "v": [vendor, ...]}` in `settings` (no table of its own, like `usage.rs`; every
//! row goes with the account). Keyed by message, so a body fetched again (evicted, refreshed)
//! counts once, as desktop's per-message entries do. The verdict outlives the cached body: what
//! was found stays found, as on desktop. Counts describe what was FOUND, never what was blocked
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
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};

/// The `settings` mark of the one-time count of bodies cached before the tally.
pub(crate) const BACKFILLED: &str = "engine.trackerTallyBackfilled.v1";
/// Vendors the page lists.
const TOP: usize = 5;
/// Rows one backfill transaction writes.
const BATCH: usize = 200;

fn key(account: &str, folder: &str, uid: i64) -> String {
    format!("acct.{account}.trackers.{folder}\n{uid}")
}

/// Records a stored body's verdict (inside the caller's write). Nothing for a body without pixels.
pub(crate) fn record<'a>(c: &Connection, account: &str, folder: &str, uid: i64, vendors: impl Iterator<Item = &'a str>, pixels: u32) -> rusqlite::Result<()> {
    if pixels == 0 {
        return Ok(());
    }
    let vendors: BTreeSet<&str> = vendors.filter(|v| !v.trim().is_empty()).collect();
    let value = json!({ "n": pixels, "v": vendors }).to_string();
    crate::settings::put_in(c, &key(account, folder, uid), &value)
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
                    if crate::settings::get_in(c, &key(a, f, *u))?.is_none() {
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
