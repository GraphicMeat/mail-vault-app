//! The RPC dispatch table. `TABLE` is the single place a method is registered;
//! `methods.json` must list exactly its names (a test checks it).

use crate::db::{Engine, SCHEMA_VERSION};
use serde::de::DeserializeOwned;
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{json, Value};
use std::fmt;

const MAX_PAGE: u64 = 200;

/// Serialized as `{ code: "UNSUPPORTED"|"INVALID"|"INTERNAL", message }`; the shell forwards it
/// to JS unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RpcError {
    Unsupported { method: String },
    Invalid(String),
    Internal(String),
}

impl RpcError {
    pub fn code(&self) -> &'static str {
        match self {
            RpcError::Unsupported { .. } => "UNSUPPORTED",
            RpcError::Invalid(_) => "INVALID",
            RpcError::Internal(_) => "INTERNAL",
        }
    }
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RpcError::Unsupported { method } => write!(f, "unsupported method: {method}"),
            RpcError::Invalid(m) | RpcError::Internal(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for RpcError {}

impl Serialize for RpcError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("RpcError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

pub(crate) type Handler = fn(&Engine, Value) -> Result<Value, RpcError>;

/// Keep sorted by name, like `methods.json`. `methods.json` lists the perf-gate build's table;
/// a shipping build answers the perf-gate-only methods (`mobile.debug.*`, `mobile.perf.report`)
/// with `Unsupported`.
#[cfg(feature = "perf-gate")]
const TABLE: &[(&str, Handler)] = &[
    ("mobile.accounts.add", crate::accounts::add),
    ("mobile.accounts.list", crate::accounts::list),
    ("mobile.accounts.remove", crate::accounts::remove),
    ("mobile.accounts.test", crate::accounts::test),
    ("mobile.debug.probe", debug_probe),
    ("mobile.debug.secretsRoundTrip", debug_secrets_round_trip),
    ("mobile.folders.list", crate::sync::folders_list),
    ("mobile.message.body", crate::body::message_body),
    ("mobile.messages.page", messages_page),
    ("mobile.perf.report", perf_report),
    ("mobile.ping", ping),
    ("mobile.sync.refresh", crate::sync::refresh),
];
#[cfg(not(feature = "perf-gate"))]
const TABLE: &[(&str, Handler)] = &[
    ("mobile.accounts.add", crate::accounts::add),
    ("mobile.accounts.list", crate::accounts::list),
    ("mobile.accounts.remove", crate::accounts::remove),
    ("mobile.accounts.test", crate::accounts::test),
    ("mobile.folders.list", crate::sync::folders_list),
    ("mobile.message.body", crate::body::message_body),
    ("mobile.messages.page", messages_page),
    ("mobile.ping", ping),
    ("mobile.sync.refresh", crate::sync::refresh),
];

/// Largest perf record accepted, serialized. The real one is a few hundred bytes.
#[cfg(feature = "perf-gate")]
const MAX_PERF_LINE: usize = 64 * 1024;

/// Names of every implemented method, in dispatch-table order.
pub fn methods() -> Vec<&'static str> {
    TABLE.iter().map(|(n, _)| *n).collect()
}

impl Engine {
    pub fn rpc(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        match TABLE.iter().find(|(n, _)| *n == method) {
            Some((_, h)) => h(self, params),
            None => Err(RpcError::Unsupported { method: method.to_string() }),
        }
    }
}

pub(crate) fn parse<T: DeserializeOwned>(params: Value) -> Result<T, RpcError> {
    // A missing params object arrives as null; treat it as empty so the error names the field.
    let params = if params.is_null() { json!({}) } else { params };
    serde_json::from_value(params).map_err(|e| RpcError::Invalid(e.to_string()))
}

fn ping(_: &Engine, _: Value) -> Result<Value, RpcError> {
    Ok(json!({ "engine": env!("CARGO_PKG_VERSION"), "schema": SCHEMA_VERSION }))
}

/// The Plan 1 form, `{accountId, folder, offset, limit}`, which the current list still sends. Goes
/// away when the list moves to the cursor form.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OffsetPageParams {
    account_id: String,
    folder: String,
    offset: u64,
    limit: u64,
}

#[derive(Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct Cursor {
    date_ms: i64,
    uid: i64,
}

/// `{accountId, folder, cursor: null|{dateMs, uid}, limit}`: the rows strictly after `cursor` in
/// `(date_ms DESC, uid DESC)` order. New mail lands above every cursor, so a page already read
/// never shifts.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CursorPageParams {
    account_id: String,
    folder: String,
    #[serde(default)]
    cursor: Option<Cursor>,
    limit: u64,
}

/// The list's view of a row: a pending local change (`local_*`) wins over the server's value, and
/// a row deleted locally is not listed.
const LISTED: &str = "account_id = ?1 AND folder = ?2 AND COALESCE(local_deleted, 0) = 0";
const ROW_COLUMNS: &str = "uid, subject, from_name, from_address, date_ms, snippet,
    COALESCE(local_seen, seen), COALESCE(local_flagged, flagged), has_attachments";

fn row_json(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "uid": r.get::<_, i64>(0)?,
        "subject": r.get::<_, String>(1)?,
        "fromName": r.get::<_, String>(2)?,
        "fromAddress": r.get::<_, String>(3)?,
        "dateMs": r.get::<_, i64>(4)?,
        "snippet": r.get::<_, String>(5)?,
        "seen": r.get::<_, i64>(6)? != 0,
        "flagged": r.get::<_, i64>(7)? != 0,
        "hasAttachments": r.get::<_, i64>(8)? != 0,
    }))
}

fn count_listed(c: &rusqlite::Connection, account: &str, folder: &str) -> rusqlite::Result<i64> {
    c.query_row(&format!("SELECT count(*) FROM messages WHERE {LISTED}"), (account, folder), |r| r.get(0))
}

/// `mobile.messages.page`: `{rows, nextCursor, total, listGen}` for the cursor form, `{rows,
/// total, listGen}` for the legacy offset form. `listGen` is read before the rows, so it is never
/// newer than them.
fn messages_page(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    if params.get("offset").is_some() {
        return offset_page(engine, parse(params)?);
    }
    let p: CursorPageParams = parse(params)?;
    let limit = p.limit.min(MAX_PAGE) as i64;
    let list_gen = engine.shared().list_gen(&p.account_id, &p.folder).map_err(|e| RpcError::Internal(e.to_string()))?;
    engine
        .read(|c| {
            let total = count_listed(c, &p.account_id, &p.folder)?;
            // limit + 1 tells whether anything follows, so `nextCursor` is null exactly at the end.
            let mut rows: Vec<(Cursor, Value)> = match p.cursor {
                None => {
                    let mut st = c.prepare_cached(&format!(
                        "SELECT {ROW_COLUMNS} FROM messages WHERE {LISTED} ORDER BY date_ms DESC, uid DESC LIMIT ?3"
                    ))?;
                    let rows = st
                        .query_map((&p.account_id, &p.folder, limit + 1), |r| {
                            Ok((Cursor { date_ms: r.get(4)?, uid: r.get(0)? }, row_json(r)?))
                        })?
                        .collect::<Result<Vec<_>, _>>()?;
                    rows
                }
                Some(cur) => {
                    let mut st = c.prepare_cached(&format!(
                        "SELECT {ROW_COLUMNS} FROM messages WHERE {LISTED} AND (date_ms, uid) < (?3, ?4)
                         ORDER BY date_ms DESC, uid DESC LIMIT ?5"
                    ))?;
                    let rows = st
                        .query_map((&p.account_id, &p.folder, cur.date_ms, cur.uid, limit + 1), |r| {
                            Ok((Cursor { date_ms: r.get(4)?, uid: r.get(0)? }, row_json(r)?))
                        })?
                        .collect::<Result<Vec<_>, _>>()?;
                    rows
                }
            };
            let more = rows.len() as i64 > limit;
            rows.truncate(limit as usize);
            let next = if more { rows.last().map(|(k, _)| json!(k)) } else { None };
            let rows: Vec<Value> = rows.into_iter().map(|(_, v)| v).collect();
            Ok(json!({ "rows": rows, "nextCursor": next, "total": total, "listGen": list_gen }))
        })
        .map_err(|e| RpcError::Internal(e.to_string()))
}

fn offset_page(engine: &Engine, p: OffsetPageParams) -> Result<Value, RpcError> {
    let limit = p.limit.min(MAX_PAGE) as i64;
    let offset = i64::try_from(p.offset).map_err(|_| RpcError::Invalid("offset out of range".into()))?;
    let list_gen = engine.shared().list_gen(&p.account_id, &p.folder).map_err(|e| RpcError::Internal(e.to_string()))?;
    engine
        .read(|c| {
            let total = count_listed(c, &p.account_id, &p.folder)?;
            let mut st = c.prepare_cached(&format!(
                "SELECT {ROW_COLUMNS} FROM messages WHERE {LISTED} ORDER BY date_ms DESC, uid DESC LIMIT ?3 OFFSET ?4"
            ))?;
            let rows = st.query_map((&p.account_id, &p.folder, limit, offset), row_json)?.collect::<Result<Vec<_>, _>>()?;
            Ok(json!({ "total": total, "rows": rows, "listGen": list_gen }))
        })
        .map_err(|e| RpcError::Internal(e.to_string()))
}

/// Logs the in-app perf probe's result as exactly one `MV_MOBILE {"perf":<object>}` line, the line
/// the gate script reads. Compact JSON escapes every control character inside a string, so no
/// field can start a second line.
#[cfg(feature = "perf-gate")]
fn perf_report(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    if !params.is_object() {
        return Err(RpcError::Invalid("perf report must be an object".into()));
    }
    let body = serde_json::to_string(&json!({ "perf": params })).map_err(|e| RpcError::Internal(e.to_string()))?;
    if body.len() > MAX_PERF_LINE {
        return Err(RpcError::Invalid(format!("perf report is {} bytes, limit {MAX_PERF_LINE}", body.len())));
    }
    debug_assert!(!body.contains('\n') && !body.contains('\r'));
    engine.log(&format!("MV_MOBILE {body}"));
    Ok(json!({ "logged": true }))
}

#[cfg(feature = "perf-gate")]
#[derive(Deserialize)]
struct ProbeParams {
    host: String,
    port: u16,
}

/// DNS and a certificate-validating TLS handshake to `{host, port}` through core's TLS seam:
/// `{ dns, tls, error }`. Proves the device's network and trust store, nothing more.
#[cfg(feature = "perf-gate")]
fn debug_probe(_: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: ProbeParams = parse(params)?;
    serde_json::to_value(crate::net::probe(&p.host, p.port)).map_err(|e| RpcError::Internal(e.to_string()))
}

/// Set, read back and delete a dummy entry in the platform secret store; booleans only.
#[cfg(feature = "perf-gate")]
fn debug_secrets_round_trip(engine: &Engine, _: Value) -> Result<Value, RpcError> {
    Ok(crate::secrets::round_trip(engine.secrets()))
}

#[cfg(all(test, not(feature = "perf-gate")))]
mod tests {
    use super::*;

    #[test]
    fn perf_gate_methods_are_unsupported_without_perf_gate() {
        let tmp = std::env::temp_dir().join(format!("mv-engine-noperf-{}", std::process::id()));
        let e = Engine::open(&tmp, &tmp.join("cache"), std::sync::Arc::new(crate::MemorySecrets::default())).unwrap();
        let err = e.rpc("mobile.perf.report", json!({ "rows": 1 })).unwrap_err();
        assert_eq!(err, RpcError::Unsupported { method: "mobile.perf.report".into() });
        assert!(!methods().contains(&"mobile.perf.report"));
        for m in ["mobile.debug.probe", "mobile.debug.secretsRoundTrip"] {
            assert_eq!(e.rpc(m, json!({})).unwrap_err(), RpcError::Unsupported { method: m.into() });
        }
        drop(e);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
