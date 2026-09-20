//! SQLite-backed mailbox tree and email-header cache.

use chrono::DateTime;
use rusqlite::{params, params_from_iter, Connection};
use serde_json::{json, Value};

fn err(e: rusqlite::Error) -> String { e.to_string() }

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn sort_ms(row: &Value) -> i64 {
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
    let value: Value = serde_json::from_str(data).map_err(|e| format!("Failed to parse cache JSON: {e}"))?;
    let object = value.as_object().ok_or("cache JSON must be an object")?;
    let tx = conn.unchecked_transaction().map_err(err)?;
    let existing: Option<String> = tx.query_row(
        "SELECT meta_json FROM header_cache_meta WHERE account_id=?1 AND mailbox_path=?2",
        params![account, mailbox], |r| r.get(0),
    ).ok();
    let mut meta = existing.and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or_else(|| json!({}));
    let map = meta.as_object_mut().ok_or("stored cache metadata is not an object")?;
    for (key, val) in object {
        if !matches!(key.as_str(), "emails" | "removedUids" | "accountId" | "mailbox") && !val.is_null() {
            map.insert(key.clone(), val.clone());
        }
    }
    tx.execute(
        "INSERT OR REPLACE INTO header_cache_meta(account_id,mailbox_path,meta_json) VALUES (?1,?2,?3)",
        params![account, mailbox, serde_json::to_string(&meta).map_err(|e| e.to_string())?],
    ).map_err(err)?;
    if let Some(rows) = object.get("emails").and_then(Value::as_array) {
        let mut stmt = tx.prepare_cached(
            "INSERT OR REPLACE INTO header_cache(account_id,mailbox_path,uid,sort_ms,updated_ms,header_json) VALUES (?1,?2,?3,?4,?5,?6)"
        ).map_err(err)?;
        for row in rows {
            let Some(uid) = row.get("uid").and_then(Value::as_u64).and_then(|u| u32::try_from(u).ok()) else { continue };
            stmt.execute(params![account, mailbox, uid, sort_ms(row), written_at, serde_json::to_string(row).map_err(|e| e.to_string())?]).map_err(err)?;
        }
    }
    if let Some(uids) = object.get("removedUids").and_then(Value::as_array) {
        let mut stmt = tx.prepare_cached("DELETE FROM header_cache WHERE account_id=?1 AND mailbox_path=?2 AND uid=?3").map_err(err)?;
        for uid in uids.iter().filter_map(Value::as_u64) { stmt.execute(params![account, mailbox, uid as i64]).map_err(err)?; }
    }
    tx.commit().map_err(err)
}

pub fn load_headers(conn: &Connection, account: &str, mailbox: &str, limit: Option<usize>) -> Result<Option<String>, String> {
    let meta: Option<String> = conn.query_row(
        "SELECT meta_json FROM header_cache_meta WHERE account_id=?1 AND mailbox_path=?2",
        params![account, mailbox], |r| r.get(0),
    ).ok();
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM header_cache WHERE account_id=?1 AND mailbox_path=?2", params![account, mailbox], |r| r.get(0)
    ).map_err(err)?;
    if meta.is_none() && count == 0 { return Ok(None); }
    let mut stmt = conn.prepare(
        "SELECT header_json FROM header_cache WHERE account_id=?1 AND mailbox_path=?2 ORDER BY sort_ms DESC, uid DESC LIMIT ?3"
    ).map_err(err)?;
    let take = limit.map(|n| n as i64).unwrap_or(-1);
    let rows = stmt.query_map(params![account, mailbox, take], |r| r.get::<_, String>(0)).map_err(err)?
        .collect::<Result<Vec<_>, _>>().map_err(err)?;
    let emails = rows.into_iter().filter_map(|s| serde_json::from_str::<Value>(&s).ok()).collect::<Vec<_>>();
    let mut out = meta.and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or_else(|| json!({}));
    let map = out.as_object_mut().ok_or("stored cache metadata is not an object")?;
    map.insert("emails".into(), Value::Array(emails));
    map.insert("totalCached".into(), json!(count));
    serde_json::to_string(&out).map(Some).map_err(|e| e.to_string())
}

pub fn load_meta(conn: &Connection, account: &str, mailbox: &str) -> Result<Option<String>, String> {
    let Some(text) = load_headers(conn, account, mailbox, Some(0))? else { return Ok(None) };
    let mut value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    value.as_object_mut().map(|m| m.remove("emails"));
    serde_json::to_string(&value).map(Some).map_err(|e| e.to_string())
}

pub fn load_by_uids(conn: &Connection, account: &str, mailbox: &str, uids: &[u32]) -> Result<Vec<Value>, String> {
    if uids.is_empty() { return Ok(Vec::new()); }
    let marks = std::iter::repeat_n("?", uids.len()).collect::<Vec<_>>().join(",");
    let sql = format!("SELECT header_json FROM header_cache WHERE account_id=? AND mailbox_path=? AND uid IN ({marks}) ORDER BY sort_ms DESC, uid DESC");
    let mut args: Vec<rusqlite::types::Value> = vec![account.to_string().into(), mailbox.to_string().into()];
    args.extend(uids.iter().map(|u| i64::from(*u).into()));
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let rows = stmt.query_map(params_from_iter(args), |r| r.get::<_, String>(0)).map_err(err)?
        .collect::<Result<Vec<_>, _>>().map_err(err)?;
    Ok(rows.into_iter().filter_map(|s| serde_json::from_str(&s).ok()).collect())
}

pub fn list_uids(conn: &Connection, account: &str, mailbox: &str, since_ms: Option<f64>) -> Result<Value, String> {
    let mut stmt = conn.prepare("SELECT uid,updated_ms FROM header_cache WHERE account_id=?1 AND mailbox_path=?2 ORDER BY uid").map_err(err)?;
    let rows = stmt.query_map(params![account, mailbox], |r| Ok((r.get::<_, u32>(0)?, r.get::<_, i64>(1)?))).map_err(err)?
        .collect::<Result<Vec<_>, _>>().map_err(err)?;
    let uids = rows.iter().map(|(uid, _)| *uid).collect::<Vec<_>>();
    let changed: Vec<u32> = since_ms.map(|since| rows.iter().filter(|(_, at)| *at as f64 > since).map(|(uid, _)| *uid).collect()).unwrap_or_default();
    Ok(json!({"uids":uids,"changed":changed}))
}

pub fn patch_flags(conn: &Connection, account: &str, mailbox: &str, changes: &[(u32, Vec<String>)]) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    let mut changed = 0;
    for (uid, flags) in changes {
        let current: Option<String> = tx.query_row(
            "SELECT header_json FROM header_cache WHERE account_id=?1 AND mailbox_path=?2 AND uid=?3",
            params![account, mailbox, uid], |r| r.get(0),
        ).ok();
        let Some(text) = current else { continue };
        let mut row: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let next = json!(flags);
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
        }
        (Some(a), None) => {
            conn.execute("DELETE FROM header_cache WHERE account_id=?1", [a]).map_err(err)?;
            conn.execute("DELETE FROM header_cache_meta WHERE account_id=?1", [a]).map_err(err)?;
        }
        (None, _) => { conn.execute("DELETE FROM header_cache", []).map_err(err)?; conn.execute("DELETE FROM header_cache_meta", []).map_err(err)?; }
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
    }
    drop(delete);
    tx.commit().map_err(err)?;
    Ok(removed)
}

pub fn rename_mailbox(conn: &Connection, account: &str, from: &str, to: &str) -> Result<(), String> {
    conn.execute("UPDATE OR REPLACE header_cache SET mailbox_path=?3 WHERE account_id=?1 AND mailbox_path=?2", params![account,from,to]).map_err(err)?;
    conn.execute("UPDATE OR REPLACE header_cache_meta SET mailbox_path=?3 WHERE account_id=?1 AND mailbox_path=?2", params![account,from,to]).map_err(err)?;
    Ok(())
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
