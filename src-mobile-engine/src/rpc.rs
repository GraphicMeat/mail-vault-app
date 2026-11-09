//! The RPC dispatch table. `TABLE` is the single place a method is registered;
//! `methods.json` must list exactly its names (a test checks it).

use crate::db::{Engine, SCHEMA_VERSION};
use serde::de::DeserializeOwned;
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{json, Value};
use std::fmt;

const MAX_PAGE: u64 = 200;

/// Serialized as `{ code: "UNSUPPORTED"|"INVALID"|"INTERNAL"|"TOO_LARGE"|"ATTACHMENT_MISSING"|
/// "SEARCH_UNAVAILABLE", message }`, and `TOO_LARGE` with `data: { limitBytes }`; the shell forwards it to JS unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RpcError {
    Unsupported { method: String },
    Invalid(String),
    Internal(String),
    /// A send's attachments are over the account's limit: `limit_bytes` of attachments
    /// (`compose::attachment_limit`).
    TooLarge { message: String, limit_bytes: u64 },
    /// A send or draft names an attachment handle that does not resolve to a picked file.
    AttachmentMissing(String),
    /// `search.db` could not be opened this run; the rest of the engine works.
    SearchUnavailable,
}

impl RpcError {
    pub fn code(&self) -> &'static str {
        match self {
            RpcError::Unsupported { .. } => "UNSUPPORTED",
            RpcError::Invalid(_) => "INVALID",
            RpcError::Internal(_) => "INTERNAL",
            RpcError::TooLarge { .. } => "TOO_LARGE",
            RpcError::AttachmentMissing(_) => "ATTACHMENT_MISSING",
            RpcError::SearchUnavailable => "SEARCH_UNAVAILABLE",
        }
    }
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RpcError::Unsupported { method } => write!(f, "unsupported method: {method}"),
            RpcError::Invalid(m) | RpcError::Internal(m) | RpcError::TooLarge { message: m, .. } | RpcError::AttachmentMissing(m) => {
                f.write_str(m)
            }
            RpcError::SearchUnavailable => f.write_str("search is unavailable"),
        }
    }
}

impl std::error::Error for RpcError {}

impl Serialize for RpcError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let limit = match self {
            RpcError::TooLarge { limit_bytes, .. } => Some(*limit_bytes),
            _ => None,
        };
        let mut st = s.serialize_struct("RpcError", if limit.is_some() { 3 } else { 2 })?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        if let Some(limit) = limit {
            st.serialize_field("data", &json!({ "limitBytes": limit }))?;
        }
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
    ("mobile.accounts.retrySignIn", crate::hold::retry),
    ("mobile.accounts.test", crate::accounts::test),
    ("mobile.actions.apply", crate::actions::apply),
    ("mobile.actions.pending", crate::actions::pending),
    ("mobile.app.state", crate::live::app_state),
    ("mobile.attachment.cancel", crate::attachments::cancel),
    ("mobile.attachment.fetch", crate::attachments::fetch),
    ("mobile.attachment.lease", crate::attachments::lease),
    ("mobile.attachment.local", crate::attachments::local),
    ("mobile.attachment.release", crate::attachments::release),
    ("mobile.compose.prepare", crate::compose::prepare),
    ("mobile.compose.send", crate::compose::send),
    ("mobile.debug.probe", debug_probe),
    ("mobile.debug.secretsRoundTrip", debug_secrets_round_trip),
    ("mobile.drafts.delete", crate::compose::drafts_delete),
    ("mobile.drafts.get", crate::compose::drafts_get),
    ("mobile.drafts.list", crate::compose::drafts_list),
    ("mobile.drafts.save", crate::compose::drafts_save),
    ("mobile.folders.list", crate::sync::folders_list),
    ("mobile.message.body", crate::body::message_body),
    ("mobile.messages.page", messages_page),
    ("mobile.oauth.begin", crate::oauth::begin),
    ("mobile.oauth.cancel", crate::oauth::cancel),
    ("mobile.oauth.finish", crate::oauth::finish),
    ("mobile.oauth.reauth", crate::oauth::reauth),
    ("mobile.outbox.discard", crate::outbox::discard),
    ("mobile.outbox.list", crate::outbox::list),
    ("mobile.outbox.retry", crate::outbox::retry),
    ("mobile.perf.report", perf_report),
    ("mobile.ping", ping),
    ("mobile.search.local", crate::search::local),
    ("mobile.search.server", crate::search::server),
    ("mobile.settings.get", crate::settings::get),
    ("mobile.settings.set", crate::settings::set),
    ("mobile.sync.refresh", crate::sync::refresh),
];
#[cfg(not(feature = "perf-gate"))]
const TABLE: &[(&str, Handler)] = &[
    ("mobile.accounts.add", crate::accounts::add),
    ("mobile.accounts.list", crate::accounts::list),
    ("mobile.accounts.remove", crate::accounts::remove),
    ("mobile.accounts.retrySignIn", crate::hold::retry),
    ("mobile.accounts.test", crate::accounts::test),
    ("mobile.actions.apply", crate::actions::apply),
    ("mobile.actions.pending", crate::actions::pending),
    ("mobile.app.state", crate::live::app_state),
    ("mobile.attachment.cancel", crate::attachments::cancel),
    ("mobile.attachment.fetch", crate::attachments::fetch),
    ("mobile.attachment.lease", crate::attachments::lease),
    ("mobile.attachment.local", crate::attachments::local),
    ("mobile.attachment.release", crate::attachments::release),
    ("mobile.compose.prepare", crate::compose::prepare),
    ("mobile.compose.send", crate::compose::send),
    ("mobile.drafts.delete", crate::compose::drafts_delete),
    ("mobile.drafts.get", crate::compose::drafts_get),
    ("mobile.drafts.list", crate::compose::drafts_list),
    ("mobile.drafts.save", crate::compose::drafts_save),
    ("mobile.folders.list", crate::sync::folders_list),
    ("mobile.message.body", crate::body::message_body),
    ("mobile.messages.page", messages_page),
    ("mobile.oauth.begin", crate::oauth::begin),
    ("mobile.oauth.cancel", crate::oauth::cancel),
    ("mobile.oauth.finish", crate::oauth::finish),
    ("mobile.oauth.reauth", crate::oauth::reauth),
    ("mobile.outbox.discard", crate::outbox::discard),
    ("mobile.outbox.list", crate::outbox::list),
    ("mobile.outbox.retry", crate::outbox::retry),
    ("mobile.ping", ping),
    ("mobile.search.local", crate::search::local),
    ("mobile.search.server", crate::search::server),
    ("mobile.settings.get", crate::settings::get),
    ("mobile.settings.set", crate::settings::set),
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
        // A journal found by `open` replays from the first call on, if no sink came first.
        self.start_startup_replay();
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
    // `perfGate`: the page enables its test hooks (`?ui=viewer`, the network probe) only then.
    Ok(json!({ "engine": env!("CARGO_PKG_VERSION"), "schema": SCHEMA_VERSION, "perfGate": cfg!(feature = "perf-gate") }))
}

#[derive(Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct Cursor {
    date_ms: i64,
    uid: i64,
}

/// `{accountId, folder, cursor: null|{dateMs, uid}, limit}`: the rows strictly after `cursor` in
/// `(date_ms DESC, uid DESC)` order. New mail lands above every cursor, so a page already read
/// never shifts. Unknown fields are refused, so a caller still on the removed Plan 1 `{offset}`
/// form fails instead of reading the first page forever.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CursorPageParams {
    account_id: String,
    folder: String,
    #[serde(default)]
    cursor: Option<Cursor>,
    limit: u64,
}

/// The list's view of a row: a pending local change (`local_*`) wins over the server's value, and
/// a row deleted locally is not listed, nor is one outside the sync window that a server search
/// stored (it shows in search results, not in the folder).
const LISTED: &str = "account_id = ?1 AND folder = ?2 AND COALESCE(local_deleted, 0) = 0 AND out_of_window_ms IS NULL";
pub(crate) const ROW_COLUMNS: &str = "uid, subject, from_name, from_address, date_ms, snippet,
    COALESCE(local_seen, seen), COALESCE(local_flagged, flagged), has_attachments, to_json";

pub(crate) fn row_json(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
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
        "to": recipients(&r.get::<_, String>(9)?),
    }))
}

/// `to_json` as the viewer's header reads it: `[{name, address}]`, empty when it does not read.
fn recipients(to_json: &str) -> Value {
    match serde_json::from_str::<Value>(to_json) {
        Ok(v @ Value::Array(_)) => v,
        _ => Value::Array(Vec::new()),
    }
}

fn count_listed(c: &rusqlite::Connection, account: &str, folder: &str) -> rusqlite::Result<i64> {
    c.query_row(&format!("SELECT count(*) FROM messages WHERE {LISTED}"), (account, folder), |r| r.get(0))
}

/// `mobile.messages.page` -> `{rows, nextCursor, total, listGen}`. `listGen` is read before the
/// rows, so it is never newer than them.
fn messages_page(engine: &Engine, params: Value) -> Result<Value, RpcError> {
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
