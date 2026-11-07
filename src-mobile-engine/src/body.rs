//! `mobile.message.body {accountId, folder, uid}`: a message's text, fetched part by part.
//!
//! The BODYSTRUCTURE names the parts; only the first `text/html` and the first `text/plain` that
//! are not attachments are downloaded (`BODY.PEEK[section]`, so opening never sets `\Seen` and an
//! attachment's bytes never cross the network). Tracking pixels are stripped from the html with
//! core's `body_scan`; remote images are counted, not loaded, and the stored html keeps their URLs
//! (the viewer's CSP blocks them until the user asks). The result is cached in `bodies`, with the
//! attachment list in `attachments`, and the list row's `snippet` is filled from the text.
//!
//! The cache is an LRU of at most [`CACHE_CAP`] bytes of `bodies`: each insert stamps the row as
//! newest and then deletes the oldest rows, at most 200 per write transaction, until the total
//! fits. A cache hit is answered from the reader pool and bumps its row only when the writer is
//! free, so opening a message never waits on a sync write.

use crate::db::{Engine, EngineError, Shared};
use crate::rpc::{parse, RpcError};
use crate::backend::{self, FolderRow, RawBody};
use crate::sync::Fail;
use mailvault_core::imap::PartInfo;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

/// Most bytes of cached bodies (html + text + parts_json of every `bodies` row).
pub(crate) const CACHE_CAP: u64 = 50 * 1024 * 1024;
/// Most rows one write transaction touches.
const BATCH: usize = 200;
const SNIPPET_CHARS: usize = 200;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BodyParams {
    account_id: String,
    folder: String,
    uid: u32,
}

/// One part as `parts_json` keeps it (core's `PartInfo`, serializable).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Part {
    section: String,
    mime: String,
    filename: Option<String>,
    size: u32,
    encoding: String,
    charset: Option<String>,
    content_id: Option<String>,
    disposition: Option<String>,
}

impl From<PartInfo> for Part {
    fn from(p: PartInfo) -> Part {
        Part {
            section: p.section,
            mime: p.mime,
            filename: p.filename,
            size: p.size,
            encoding: p.encoding,
            charset: p.charset,
            content_id: p.content_id,
            disposition: p.disposition,
        }
    }
}

/// What `parts_json` holds: every part, and what the scan of the html found.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    parts: Vec<Part>,
    remote_images: u32,
    trackers: u32,
}

/// A body as the reply carries it.
struct Body {
    html: Option<String>,
    text: Option<String>,
    stored: Stored,
}

impl Body {
    fn reply(&self) -> Value {
        let attachments: Vec<Value> = attachments_of(&self.stored.parts)
            .iter()
            .map(|p| json!({ "section": p.section, "filename": p.filename, "mime": p.mime, "size": p.size, "contentId": p.content_id }))
            .collect();
        json!({
            "html": self.html, "text": self.text, "attachments": attachments,
            "remoteImages": self.stored.remote_images, "trackers": self.stored.trackers, "gone": false,
        })
    }
}

fn gone() -> Value {
    json!({ "html": null, "text": null, "attachments": [], "remoteImages": 0, "trackers": 0, "gone": true })
}

fn is_attachment(p: &Part) -> bool {
    p.disposition.as_deref() == Some("attachment")
}

/// The parts read as the body: the first `text/html` and the first `text/plain` that are not
/// attachments, as `(html, text)`.
fn body_parts(parts: &[Part]) -> (Option<&Part>, Option<&Part>) {
    let first = |mime: &str| parts.iter().find(|p| p.mime == mime && !is_attachment(p));
    (first("text/html"), first("text/plain"))
}

/// [`body_parts`] over core's parts, for a backend that reads the body itself.
pub(crate) fn body_part_infos(parts: &[PartInfo]) -> (Option<&PartInfo>, Option<&PartInfo>) {
    let own: Vec<Part> = parts.iter().cloned().map(Part::from).collect();
    let (html, text) = body_parts(&own);
    let find = |p: Option<&Part>| p.and_then(|p| parts.iter().find(|q| q.section == p.section));
    (find(html), find(text))
}

/// Everything that is not the body: attachments, inline images (by `contentId`), a forwarded
/// message. A further text alternative with no name and no attachment disposition is neither,
/// and is left out, as the desktop reader leaves it out.
fn attachments_of(parts: &[Part]) -> Vec<&Part> {
    let (html, text) = body_parts(parts);
    let chosen = |p: &Part| [html, text].iter().flatten().any(|c| c.section == p.section);
    parts
        .iter()
        .filter(|p| !chosen(p))
        .filter(|p| is_attachment(p) || p.filename.is_some() || !matches!(p.mime.as_str(), "text/plain" | "text/html"))
        .collect()
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// An access stamp later than every other row's, so rows touched within one millisecond still
/// order (the table is WITHOUT ROWID: there is no hidden tie-breaker).
const STAMP: &str = "max(?4, COALESCE((SELECT max(last_access_ms) FROM bodies), 0) + 1)";
const KEY: &str = "account_id = ?1 AND folder = ?2 AND uid = ?3";

fn cap(shared: &Shared) -> u64 {
    #[cfg(test)]
    {
        shared.body_cap.load(std::sync::atomic::Ordering::SeqCst)
    }
    #[cfg(not(test))]
    {
        let _ = shared;
        CACHE_CAP
    }
}

/// `mobile.message.body {accountId, folder, uid}` -> `{html, text, attachments: [{section,
/// filename, mime, size, contentId}], remoteImages, trackers, gone}`. A network failure is an
/// `INTERNAL` error whose message is the accounts error code (`TIMEOUT`, `HOST_UNREACHABLE`, ...);
/// the detail goes to the log only.
pub(crate) fn message_body(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: BodyParams = parse(params)?;
    let shared = engine.shared();
    if let Some(hit) = cached(shared, &p).map_err(internal)? {
        // Skipped when a sync write holds the writer: a stale stamp only makes the row an
        // earlier eviction candidate.
        let _ = shared.try_write(|c| c.execute(&format!("UPDATE bodies SET last_access_ms = {STAMP} WHERE {KEY}"), key(&p)));
        return Ok(hit.reply());
    }
    let validity: Option<Option<i64>> = shared
        .read(|c| {
            c.query_row("SELECT uid_validity FROM folders WHERE account_id = ?1 AND path = ?2", (&p.account_id, &p.folder), |r| r.get(0))
                .optional()
        })
        .map_err(internal)?;
    let Some(validity) = validity else {
        return Err(RpcError::Invalid("unknown folder".into()));
    };
    let (body, snippet) = match fetch(shared, &p, validity) {
        Ok(Some(b)) => b,
        Ok(None) => return Ok(gone()),
        Err(Fail::Gone) => return Err(RpcError::Invalid("unknown account".into())),
        Err(Fail::Closing) => return Err(RpcError::Internal("the engine is closing".into())),
        Err(Fail::Code(code, why)) => {
            shared.log(&format!("[body] {} {} {}: {} {}", p.account_id, p.folder, p.uid, code.as_str(), why));
            return Err(RpcError::Internal(code.as_str().into()));
        }
    };
    store(shared, &p, &body, &snippet).map_err(internal)?;
    evict(shared, cap(shared), &p).map_err(internal)?;
    Ok(body.reply())
}

fn internal(e: impl ToString) -> RpcError {
    RpcError::Internal(e.to_string())
}

fn key(p: &BodyParams) -> (&str, &str, i64, i64) {
    (&p.account_id, &p.folder, p.uid as i64, now_ms())
}

fn cached(shared: &Shared, p: &BodyParams) -> Result<Option<Body>, EngineError> {
    let row: Option<(Option<String>, Option<String>, Option<String>)> = shared.read(|c| {
        c.query_row(&format!("SELECT html, text, parts_json FROM bodies WHERE {KEY}"), (&p.account_id, &p.folder, p.uid as i64), |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()
    })?;
    // A row whose parts no longer read is refetched (and replaced) rather than trusted.
    Ok(row.and_then(|(html, text, parts)| {
        let stored: Stored = serde_json::from_str(parts.as_deref()?).ok()?;
        Some(Body { html, text, stored })
    }))
}

/// Signs in, lists the parts and fetches the body parts. `Ok(None)` when the uid is gone, or now
/// names a different message (the folder's UIDVALIDITY moved; the next sync wipes the folder).
fn fetch(shared: &Shared, p: &BodyParams, stored_validity: Option<i64>) -> Result<Option<(Body, String)>, Fail> {
    let mut backend = backend::open(shared, &p.account_id)?;
    let out = backend.body(&FolderRow::new(&p.folder, stored_validity), p.uid);
    // Signs out.
    drop(backend);
    Ok(out?.map(|RawBody { parts, html, text }| scanned(html, text, parts.into_iter().map(Part::from).collect())))
}

/// Strips the html's tracking pixels and counts the remote images the cleaned html would load.
/// The snippet comes with it, read from the html before a marker replaced any beacon.
fn scanned(html: Option<String>, text: Option<String>, parts: Vec<Part>) -> (Body, String) {
    let snippet = snippet_of(html.as_deref(), text.as_deref());
    let (mut remote_images, mut trackers) = (0, 0);
    let html = html.map(|h| {
        // Empty templates: the marker that replaces a beacon carries no catalog key or English
        // text; the viewer labels `[data-mv-tracker-blocked]` in the UI language.
        let blank: serde_json::Map<String, Value> =
            mailvault_core::body_scan::TEXT_KEYS.iter().map(|k| (k.to_string(), Value::String(String::new()))).collect();
        let scan = mailvault_core::body_scan::scan_trackers(&h, &mailvault_core::body_scan::Texts::from_value(Some(&Value::Object(blank))));
        remote_images = scan.remote_cleaned as u32;
        trackers = scan.trackers.len() as u32;
        scan.cleaned.unwrap_or(h)
    });
    (Body { html, text, stored: Stored { parts, remote_images, trackers } }, snippet)
}

/// Perf-gate screenshots: caches `html` / `text` as the body of a listed message, scanned the way
/// a fetched body is (trackers stripped, remote images counted), with `attachments` as
/// `(filename, mime, size)` parts. `INSERT OR IGNORE`: a body already there is left alone.
#[cfg(feature = "perf-gate")]
pub(crate) fn seed_body(
    c: &Connection,
    account: &str,
    folder: &str,
    uid: i64,
    html: Option<&str>,
    text: Option<&str>,
    attachments: &[(&str, &str, u32)],
) -> rusqlite::Result<()> {
    let part = |section: usize, mime: &str, filename: Option<&str>, size: usize, disposition: Option<&str>| Part {
        section: section.to_string(),
        mime: mime.to_string(),
        filename: filename.map(str::to_string),
        size: size as u32,
        encoding: "7bit".into(),
        charset: Some("utf-8".into()),
        content_id: None,
        disposition: disposition.map(str::to_string),
    };
    let mut parts = Vec::new();
    if let Some(h) = html {
        parts.push(part(parts.len() + 1, "text/html", None, h.len(), None));
    }
    if let Some(t) = text {
        parts.push(part(parts.len() + 1, "text/plain", None, t.len(), None));
    }
    for (name, mime, size) in attachments {
        parts.push(part(parts.len() + 1, mime, Some(name), *size as usize, Some("attachment")));
    }
    let (body, _) = scanned(html.map(str::to_string), text.map(str::to_string), parts);
    let parts_json = serde_json::to_string(&body.stored).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    let bytes = body.html.as_ref().map_or(0, String::len) + body.text.as_ref().map_or(0, String::len) + parts_json.len();
    for a in attachments_of(&body.stored.parts) {
        c.execute(
            "INSERT OR IGNORE INTO attachments (account_id, folder, uid, section, filename, mime, size, content_id, encoding)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            (account, folder, uid, &a.section, a.filename.as_deref().unwrap_or(""), &a.mime, a.size as i64, &a.content_id, &a.encoding),
        )?;
    }
    c.execute(
        "INSERT OR IGNORE INTO bodies (account_id, folder, uid, html, text, parts_json, bytes, last_access_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
        (account, folder, uid, &body.html, &body.text, &parts_json, bytes as i64),
    )?;
    Ok(())
}

/// The list row's preview: the text (else the html's text), whitespace collapsed, 200 chars.
fn snippet_of(html: Option<&str>, text: Option<&str>) -> String {
    let from_html;
    let source = match text.filter(|t| !t.trim().is_empty()) {
        Some(t) => t,
        None => {
            from_html = html.map(mailvault_core::search_index::text::html_to_text).unwrap_or_default();
            &from_html
        }
    };
    source.split_whitespace().flat_map(|w| std::iter::once(' ').chain(w.chars())).skip(1).take(SNIPPET_CHARS).collect()
}

/// Whether the message row is still there; a body is cached only for a listed message, so the
/// sync worker's removal of the row takes the body with it.
fn message_exists(c: &Connection, p: &BodyParams) -> rusqlite::Result<bool> {
    c.query_row("SELECT 1 FROM messages WHERE account_id = ?1 AND folder = ?2 AND uid = ?3", (&p.account_id, &p.folder, p.uid as i64), |_| Ok(()))
        .optional()
        .map(|o| o.is_some())
}

/// Writes the attachment rows (at most [`BATCH`] per transaction), then the body row and the
/// snippet in one last transaction, so a body row means its attachment rows are in place.
fn store(shared: &Shared, p: &BodyParams, body: &Body, snippet: &str) -> Result<(), EngineError> {
    let attachments = attachments_of(&body.stored.parts);
    for chunk in attachments.chunks(BATCH) {
        let done = shared.write(|c| {
            if !message_exists(c, p)? {
                return Ok(false);
            }
            let mut st = c.prepare_cached(
                "INSERT OR REPLACE INTO attachments (account_id, folder, uid, section, filename, mime, size, content_id, encoding)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )?;
            for a in chunk {
                st.execute((
                    &p.account_id,
                    &p.folder,
                    p.uid as i64,
                    &a.section,
                    a.filename.as_deref().unwrap_or(""),
                    &a.mime,
                    a.size as i64,
                    &a.content_id,
                    &a.encoding,
                ))?;
            }
            Ok(true)
        })?;
        if !done {
            return Ok(());
        }
    }
    let parts_json = serde_json::to_string(&body.stored).map_err(|e| EngineError::Db(e.to_string()))?;
    let bytes = body.html.as_ref().map_or(0, String::len) + body.text.as_ref().map_or(0, String::len) + parts_json.len();
    shared.write(|c| {
        if !message_exists(c, p)? {
            return Ok(());
        }
        let (account, folder, uid, now) = key(p);
        c.execute(
            &format!(
                "INSERT OR REPLACE INTO bodies (account_id, folder, uid, html, text, parts_json, bytes, last_access_ms)
                 VALUES (?1, ?2, ?3, ?5, ?6, ?7, ?8, {STAMP})"
            ),
            (account, folder, uid, now, &body.html, &body.text, &parts_json, bytes as i64),
        )?;
        c.execute(&format!("UPDATE messages SET snippet = ?4 WHERE {KEY}"), (account, folder, uid, snippet))?;
        Ok(())
    })
}

/// Deletes the least recently opened bodies until the total is at most `cap`, never the row of
/// `keep` (the body just stored). Each round reads through the pool and deletes at most
/// [`BATCH`] rows in its own write transaction.
fn evict(shared: &Shared, cap: u64, keep: &BodyParams) -> Result<usize, EngineError> {
    let mut removed = 0;
    loop {
        let total: i64 = shared.read(|c| c.query_row("SELECT COALESCE(sum(bytes), 0) FROM bodies", [], |r| r.get(0)))?;
        let mut over = total - cap as i64;
        if over <= 0 {
            return Ok(removed);
        }
        let oldest: Vec<(String, String, i64, i64)> = shared.read(|c| {
            let mut st = c.prepare_cached(&format!(
                "SELECT account_id, folder, uid, bytes FROM bodies
                 WHERE NOT (account_id = ?1 AND folder = ?2 AND uid = ?3)
                 ORDER BY last_access_ms ASC LIMIT {BATCH}"
            ))?;
            let rows = st
                .query_map((&keep.account_id, &keep.folder, keep.uid as i64), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        if oldest.is_empty() {
            return Ok(removed);
        }
        let mut victims = Vec::new();
        for row in oldest {
            if over <= 0 {
                break;
            }
            over -= row.3;
            victims.push(row);
        }
        removed += shared.write(|c| {
            let mut st = c.prepare_cached("DELETE FROM bodies WHERE account_id = ?1 AND folder = ?2 AND uid = ?3")?;
            let mut n = 0;
            for (a, f, u, _) in &victims {
                n += st.execute((a, f, u))?;
            }
            Ok(n)
        })?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mock_imap::state::{Mailbox, Message};
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    fn part(section: &str, mime: &str, filename: Option<&str>, disposition: Option<&str>) -> Part {
        Part {
            section: section.into(),
            mime: mime.into(),
            filename: filename.map(String::from),
            size: 1,
            encoding: "7bit".into(),
            charset: None,
            content_id: None,
            disposition: disposition.map(String::from),
        }
    }

    #[test]
    fn picks_body_parts_and_attachments() {
        let parts = vec![
            part("1.1", "text/plain", None, None),
            part("1.2", "text/html", None, None),
            part("2", "text/plain", Some("notes.txt"), Some("attachment")),
            part("3", "image/png", None, Some("inline")),
            part("4", "text/plain", None, None),
        ];
        let (html, text) = body_parts(&parts);
        assert_eq!(html.unwrap().section, "1.2");
        assert_eq!(text.unwrap().section, "1.1");
        let att: Vec<&str> = attachments_of(&parts).iter().map(|p| p.section.as_str()).collect();
        assert_eq!(att, ["2", "3"]);
    }

    #[test]
    fn snippet_collapses_whitespace_and_falls_back_to_html() {
        assert_eq!(snippet_of(None, Some("  Hello\r\n\r\n  there\tyou  ")), "Hello there you");
        assert_eq!(snippet_of(Some("<p>Hi</p><p>all</p>"), None), "Hi all");
        assert_eq!(snippet_of(Some("<p>Hi</p>"), Some(" \r\n")), "Hi");
        assert_eq!(snippet_of(None, Some(&"x".repeat(500))).chars().count(), 200);
    }

    fn html_message(uid: u32, kb: usize) -> Message {
        let now = now_ms();
        let filler = "<p>lorem ipsum dolor sit amet</p>\r\n".repeat(kb * 1024 / 34 + 1);
        Message::new(
            uid,
            format!(
                "From: a <a@example.com>\r\nSubject: s{uid}\r\nMessage-ID: <lru{uid}@x>\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body>{filler}</body></html>\r\n"
            ),
        )
        .with_internal_ms(now - 86_400_000 + uid as i64)
    }

    fn uids_cached(e: &Engine) -> Vec<i64> {
        e.read(|c| {
            let mut st = c.prepare("SELECT uid FROM bodies ORDER BY uid")?;
            let rows = st.query_map([], |r| r.get(0))?.collect::<Result<Vec<i64>, _>>()?;
            Ok(rows)
        })
        .unwrap()
    }

    fn total_bytes(e: &Engine) -> i64 {
        e.read(|c| c.query_row("SELECT COALESCE(sum(bytes), 0) FROM bodies", [], |r| r.get(0))).unwrap()
    }

    /// Past the cap, the least recently opened bodies go first (a cache hit counts as opening),
    /// the body just fetched always stays, and a large eviction deletes at most 200 rows per write.
    #[test]
    fn body_cache_evicts_lru_past_cap() {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
        let mut mb = Mailbox::new("INBOX");
        for uid in 1..=4 {
            mb.add(html_message(uid, 10));
        }
        let server = mock_imap::MockImap::start(mock_imap::Scenario::new().mailbox(mb));
        let tmp = tempfile::tempdir().unwrap();
        let e = Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(crate::MemorySecrets::default())).unwrap();
        let added = e
            .rpc(
                "mobile.accounts.add",
                json!({ "email": "u@example.test", "password": "pw", "imapHost": server.host(), "imapPort": server.port(), "security": "none", "smtpHost": server.host(), "smtpPort": server.smtp_port(), "smtpSecurity": "starttls" }),
            )
            .unwrap();
        let account = added["account"]["id"].as_str().unwrap().to_string();
        crate::sync::sync_now_for_test(e.shared(), &account, None);
        let body = |uid: u32| {
            let v = e.rpc("mobile.message.body", json!({ "accountId": account, "folder": "INBOX", "uid": uid })).unwrap();
            assert_eq!(v["gone"], false, "{v}");
            v
        };

        // Room for three ~10 KB bodies, not four.
        body(1);
        let one = total_bytes(&e);
        e.shared().body_cap.store((one * 3 + one / 2) as u64, Ordering::SeqCst);
        body(2);
        body(3);
        assert_eq!(uids_cached(&e), [1, 2, 3]);
        body(1); // a hit: 1 is now the newest, 2 the oldest
        body(4);
        assert_eq!(uids_cached(&e), [1, 3, 4]);
        assert!(total_bytes(&e) as u64 <= e.shared().body_cap.load(Ordering::SeqCst));

        // 450 small rows of other messages, then a cap only the next body fits under.
        e.write(|c| {
            for uid in 1000..1450i64 {
                c.execute(
                    "INSERT INTO bodies (account_id, folder, uid, text, parts_json, bytes, last_access_ms) VALUES (?1, 'Old', ?2, 'x', '{}', 100, ?2)",
                    (&account, uid),
                )?;
            }
            Ok(())
        })
        .unwrap();
        e.shared().body_cap.store(1, Ordering::SeqCst);
        e.write(|c| c.execute("DELETE FROM bodies WHERE folder = 'INBOX' AND uid = 2", [])).unwrap();
        e.shared().max_txn_rows(true);
        body(2);
        assert_eq!(uids_cached(&e), [2], "only the body just fetched stays");
        let max = e.shared().max_txn_rows(false);
        assert!(max > 0 && max <= 200, "an eviction transaction changed {max} rows");
    }
}
