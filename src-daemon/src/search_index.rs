//! The search index in the daemon (spec 2026-09-14 §5.3): a port of the app's
//! `src-tauri/src/search_index.rs` with `AppHandle` replaced by this state, which
//! owns the vault root (the daemon restarts on a vault switch) and the event bus.
//! Only the `search-index` thread opens the index (it runs quick_check).
//!
//! Lock order: `db` may be held while `root` or `phase` is taken; never take
//! `root`, `phase`, `enabled` or `config` and then `db`.

use crate::events::EventBus;
use mailvault_core::search_index::plan::Signal;
use mailvault_core::search_index::reconcile::{AttachmentMeta, IndexConfig, IndexDoc};
use mailvault_core::search_index::slot::SwitchGuard;
use mailvault_core::search_index::{self as core, db, lock, SharedConn};
use mailvault_core::vault_eml::{collect_attachment_parts, find_file_by_uid, parse_eml_bytes_light, parse_flags_from_filename, part_filename, read_light_at};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use tracing::warn;

pub struct SearchIndexState {
    pub db: SharedConn,
    pub(crate) root: Mutex<Option<PathBuf>>,
    pub(crate) vault_root: PathBuf,
    pub(crate) mail_dir_ok: bool,
    pub(crate) bus: EventBus,
    pub(crate) config: Mutex<Option<IndexConfig>>,
    /// None until the first configure; Some(false) = destroyed or switched off.
    pub(crate) enabled: Mutex<Option<bool>>,
    pub(crate) signals: Mutex<Option<mpsc::Sender<Signal>>>,
    pub(crate) phase: Mutex<&'static str>, // "idle" | "indexing" | "unavailable" | "off"
    pub(crate) interrupt: AtomicBool,
    pub(crate) switch: SwitchGuard,
    pub(crate) destroy_reply: Mutex<Option<mpsc::Sender<Result<(), &'static str>>>>,
}

impl SearchIndexState {
    pub fn new(vault_root: PathBuf, mail_dir_ok: bool, bus: EventBus) -> Arc<Self> {
        Arc::new(Self {
            db: Mutex::new(None),
            root: Mutex::new(None),
            vault_root,
            mail_dir_ok,
            bus,
            config: Mutex::new(None),
            enabled: Mutex::new(None),
            signals: Mutex::new(None),
            phase: Mutex::new("unavailable"),
            interrupt: AtomicBool::new(false),
            switch: SwitchGuard::default(),
            destroy_reply: Mutex::new(None),
        })
    }
}

pub(crate) fn g<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// The text the index holds for a list row: the longer of its text part and its
/// HTML part as text. Newsletters often ship a one-line text stub ("View this
/// email in your browser") with the whole message only in the HTML.
fn body_of(row: &serde_json::Value) -> String {
    let text = row.get("text").and_then(|v| v.as_str()).unwrap_or("");
    let html = row.get("html").and_then(|v| v.as_str()).map(core::text::html_to_text).unwrap_or_default();
    // Trimmed, so a whitespace-only text part never beats real HTML text.
    if html.trim().chars().count() > text.trim().chars().count() { html } else { text.to_string() }
}

/// A list-row address as `Name <address>`, or the bare address.
fn addr_text(v: &serde_json::Value) -> String {
    let a = v.get("address").and_then(|x| x.as_str()).unwrap_or("");
    match v.get("name").and_then(|x| x.as_str()) {
        Some(n) if !n.is_empty() => format!("{n} <{a}>"),
        _ => a.to_string(),
    }
}

/// Upper bound on a MIME part's decoded body size, without decoding it: a
/// part's raw bytes (its own headers + still-encoded body) are always >= the
/// decoded body, since base64/quoted-printable only ever grow bytes. Lets
/// callers reject an oversized attachment before `get_body_raw()` allocates
/// the full decode.
fn encoded_part_size(part: &mailparse::ParsedMail) -> u64 {
    part.raw_bytes.len() as u64
}

/// `ParseFn` for core: the list-row parser, so rows and the index agree on one parser.
pub fn index_doc_from_light(raw: &[u8], uid: u32, filename: &str) -> Option<IndexDoc> {
    let email = parse_eml_bytes_light(raw, uid, parse_flags_from_filename(filename)).ok()?;
    let mut row = serde_json::to_value(&email).ok()?;
    let body_text = body_of(&row);
    let obj = row.as_object_mut()?;
    for k in ["text", "html", "flags"] {
        obj.remove(k);
    }
    let from = obj.get("from").cloned().unwrap_or(serde_json::Value::Null);
    let mut addrs = vec![addr_text(&from)];
    for key in ["to", "cc", "bcc", "replyTo"] {
        if let Some(list) = obj.get(key).and_then(|v| v.as_array()) {
            addrs.extend(list.iter().map(addr_text));
        }
    }
    // Attachment candidates need the real MIME tree; the light parse above
    // only surfaces text/html + headers. A full re-parse failure here just
    // means no candidates get listed (an unparseable message already fails
    // the light parse above and returns None before this point).
    let attachment_candidates = mailparse::parse_mail(raw)
        .map(|parsed| {
            let mut parts = Vec::new();
            collect_attachment_parts(&parsed, &mut parts);
            parts
                .into_iter()
                .map(|part| AttachmentMeta {
                    filename: part_filename(part),
                    mime: part.ctype.mimetype.clone(),
                    size: encoded_part_size(part),
                })
                .collect()
        })
        .unwrap_or_default();
    Some(IndexDoc {
        message_id: obj.get("messageId").and_then(|v| v.as_str()).map(String::from),
        date_utc: obj.get("date").and_then(|v| v.as_str()).and_then(|d| mailparse::dateparse(d).ok()),
        from_addr: from.get("address").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        from_name: from.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        addrs: addrs.into_iter().filter(|a| !a.is_empty()).collect(),
        subject: obj.get("subject").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        body_text,
        has_attachments: obj.get("hasAttachments").and_then(|v| v.as_bool()).unwrap_or(false),
        row_json: serde_json::to_string(&row).ok()?,
        attachment_candidates,
    })
}

/// Read one attachment part's raw bytes off disk and re-parse the message it
/// lives in, for `reconcile::run_pending_extractions`'s `read_part` callback.
/// Looks the message up by uid (not by the `filename` recorded at the last
/// reconcile) so a flag rename since then does not miss it; `part_index` is
/// still keyed off `collect_attachment_parts`'s order, which is stable for a
/// given message body.
pub(crate) fn read_attachment_part(
    maildir_root: &Path,
    account_id: &str,
    vault_dir: &str,
    uid: u32,
    _filename: &str,
    part_index: usize,
) -> Option<(mailvault_core::search_index::attachments::AttachmentInput, IndexDoc)> {
    let cur = maildir_root.join(account_id).join(vault_dir).join("cur");
    let path = find_file_by_uid(&cur, uid)?;
    let raw = std::fs::read(&path).ok()?;
    let current_filename = path.file_name()?.to_string_lossy().into_owned();
    let parsed = mailparse::parse_mail(&raw).ok()?;
    let mut parts = Vec::new();
    collect_attachment_parts(&parsed, &mut parts);
    let part = parts.get(part_index)?;
    let mime = part.ctype.mimetype.clone();
    let filename = part_filename(part);
    let doc = index_doc_from_light(&raw, uid, &current_filename)?;
    // Size-check the ENCODED bytes before ever decoding: get_body_raw() fully
    // base64-decodes the part into RAM, so a hostile multi-hundred-MB
    // attachment must be rejected before that allocation, not after. `extract()`
    // checks `input.size` against MAX_PART_BYTES before touching `input.bytes`
    // for anything but the actual text/office/pdf/image extraction branches,
    // so an empty placeholder here is safe and correctly classifies as too_large.
    let encoded_size = encoded_part_size(part);
    if encoded_size > mailvault_core::search_index::attachments::MAX_PART_BYTES {
        return Some((
            mailvault_core::search_index::attachments::AttachmentInput {
                filename,
                mime,
                size: encoded_size,
                bytes: Vec::new(),
            },
            doc,
        ));
    }
    let bytes = part.get_body_raw().ok()?;
    Some((
        mailvault_core::search_index::attachments::AttachmentInput {
            filename,
            mime,
            size: bytes.len() as u64,
            bytes,
        },
        doc,
    ))
}

/// One row per hit, in hit order: the list row read from the hit's own file,
/// plus `vaultDir`, `snippet` and `matchedIn`. The index knows each filename,
/// so there is no folder listing; `read_light_at` rescans once only if the file
/// was renamed since (a flag change). A hit whose file is gone, or whose uid now
/// holds a message with another Message-ID, is dropped and `total` still counts
/// it until the next sweep: transient, never a wrong row.
pub fn assemble_rows(root: &Path, account_id: &str, page: &core::query::SearchPage) -> Vec<serde_json::Value> {
    page.hits
        .iter()
        .filter_map(|h| {
            let cur = root.join("Maildir").join(account_id).join(&h.vault_dir).join("cur");
            let email = read_light_at(&cur, h.uid, Some(&cur.join(&h.filename)))?;
            let mut row = serde_json::to_value(&email).ok()?;
            // A UID reissue repair since the last sweep can give this uid to another
            // message: that row is not this hit. Same parser on both sides, so exact.
            if let Some(indexed) = &h.message_id {
                if row.get("messageId").and_then(|v| v.as_str()) != Some(indexed.as_str()) {
                    return None;
                }
            }
            let body = body_of(&row);
            let subject = row.get("subject").and_then(|s| s.as_str()).unwrap_or("").to_string();
            // Names and addresses only: the JSON text around them would match `name` or `address`.
            let from = addr_text(&row["from"]);
            let to = ["to", "cc", "bcc"]
                .iter()
                .filter_map(|k| row.get(*k)?.as_array())
                .flatten()
                .map(addr_text)
                .collect::<Vec<_>>()
                .join(" ");
            let matched: Vec<&str> = [("subject", &subject), ("from", &from), ("to", &to), ("body", &body)]
                .into_iter()
                .filter(|(_, text)| page.needles.iter().any(|n| core::text::contains_folded(text, n)))
                .map(|(label, _)| label)
                .collect();
            let obj = row.as_object_mut()?;
            obj.insert("vaultDir".into(), h.vault_dir.clone().into());
            obj.insert("snippet".into(), core::text::snippet(&body, &page.needles, 160).into());
            obj.insert("matchedIn".into(), matched.into());
            Some(row)
        })
        .collect()
}

pub fn status_json(st: &SearchIndexState) -> Value {
    // `enabled` is read and released before `db` is locked (lock order).
    let enabled = *g(&st.enabled);
    if enabled == Some(false) {
        return serde_json::json!({ "available": false, "state": "off", "indexed": 0, "total": 0, "sizeBytes": 0, "complete": false, "firstPassDone": false });
    }
    let guard = lock(&st.db);
    let Some(conn) = guard.as_ref() else {
        return serde_json::json!({ "available": false, "state": "unavailable", "indexed": 0, "total": 0, "sizeBytes": 0, "complete": false, "firstPassDone": false });
    };
    let c = db::counts(conn);
    let size = g(&st.root).as_ref().map(|r| db::db_size_bytes(r)).unwrap_or(0);
    // counts() yields 0/0 on error: never "complete". Available whenever open, so
    // Settings shows a first build's progress; only vault_search waits for first_pass_done.
    serde_json::json!({
        "available": true,
        "state": *g(&st.phase),
        "indexed": c.indexed,
        "total": c.total,
        "sizeBytes": size,
        "complete": c.total > 0 && c.indexed >= c.total,
        "firstPassDone": db::first_pass_done(conn),
    })
}

pub(crate) fn emit(st: &SearchIndexState) {
    st.bus.emit("search-index-progress", status_json(st));
}

/// `{ available: false }` until the worker has opened the index and finished
/// its first full pass over it.
pub fn search_reply(st: &SearchIndexState, request: &core::query::SearchRequest) -> Result<serde_json::Value, String> {
    // `enabled` is read and released before `db` is locked (lock order).
    if *g(&st.enabled) == Some(false) {
        return Ok(serde_json::json!({ "available": false }));
    }
    let (root, page, counts) = {
        let guard = lock(&st.db);
        // Root read under the db lock, so it is the root this connection was opened for.
        let (Some(conn), Some(root)) = (guard.as_ref(), g(&st.root).clone()) else {
            return Ok(serde_json::json!({ "available": false }));
        };
        // A first build (or a rebuild) still misses mail the scan finds.
        if !db::first_pass_done(conn) {
            return Ok(serde_json::json!({ "available": false }));
        }
        (root, core::query::search(conn, request)?, db::counts(conn))
    }; // released before any file is read
    let rows = assemble_rows(&root, &request.account_id, &page);
    Ok(serde_json::json!({
        "available": true,
        "rows": rows,
        "total": page.total,
        "indexed": counts.indexed,
        "totalMessages": counts.total,
        "complete": counts.total > 0 && counts.indexed >= counts.total,
    }))
}

/// The index's list rows for `uids` of one folder: `row_json` (headers,
/// attachments list, no body) with `flags` and `isArchived` read off the
/// CURRENT filename, so a flag rename since the last sweep is not stale here.
/// Only uids the index holds, in request order; the caller reads the rest
/// from their files. Empty while the index is closed. Replaces the
/// archived-headers cache file, which was these rows with a second copy of
/// the body text.
pub fn rows_reply(st: &SearchIndexState, account_id: &str, mailbox: &str, uids: &[u32]) -> Vec<serde_json::Value> {
    let guard = lock(&st.db);
    let Some(conn) = guard.as_ref() else { return Vec::new() };
    let vault_dir = core::text::vault_dir_name(mailbox);
    let mut stmt = match conn.prepare_cached("SELECT filename, row_json FROM messages WHERE account_id = ?1 AND vault_dir = ?2 AND uid = ?3") {
        Ok(s) => s,
        Err(e) => {
            warn!("vault_rows: {e}");
            return Vec::new();
        }
    };
    uids.iter()
        .filter_map(|uid| {
            let (filename, row_json): (String, String) = stmt
                .query_row((account_id, vault_dir.as_str(), *uid), |r| Ok((r.get(0)?, r.get(1)?)))
                .ok()?;
            let mut row: serde_json::Value = serde_json::from_str(&row_json).ok()?;
            let flags = parse_flags_from_filename(&filename);
            let obj = row.as_object_mut()?;
            obj.insert("uid".into(), (*uid).into());
            obj.insert("isArchived".into(), flags.iter().any(|f| f == "archived").into());
            obj.insert("flags".into(), serde_json::json!(flags));
            Some(row)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    fn eml_html() -> Vec<u8> {
        b"From: Ann Lee <ann@x.test>\r\nTo: Bob <bob@x.test>\r\nCc: carol@x.test\r\nSubject: Quarterly numbers\r\nMessage-ID: <q@x.test>\r\nDate: Sat, 12 Sep 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Revenue&nbsp;grew <b>12%</b></p><style>x{}</style>\r\n".to_vec()
    }

    #[test]
    fn adapter_builds_doc_from_the_app_parser() {
        let doc = crate::search_index::index_doc_from_light(&eml_html(), 7, "7:2,S.eml").expect("parses");
        assert_eq!(doc.subject, "Quarterly numbers");
        assert_eq!(doc.from_addr, "ann@x.test");
        assert_eq!(doc.from_name, "Ann Lee");
        assert!(doc.addrs.iter().any(|a| a.contains("bob@x.test")));
        assert!(doc.addrs.iter().any(|a| a.contains("carol@x.test")));
        assert_eq!(doc.body_text, "Revenue grew 12%");
        assert_eq!(doc.message_id.as_deref(), Some("<q@x.test>"));
        assert_eq!(doc.date_utc, Some(1789207200));
        let row: serde_json::Value = serde_json::from_str(&doc.row_json).unwrap();
        assert!(row.get("text").map_or(true, |v| v.is_null()), "row_json has no body");
        assert!(row.get("html").map_or(true, |v| v.is_null()));
        assert!(row.get("flags").is_none(), "flags come from the filename at read time");
        assert_eq!(row["subject"], "Quarterly numbers");
    }

    fn eml_alternative(plain: &str, html: &str) -> Vec<u8> {
        format!(
            "From: Ann <ann@x.test>\r\nTo: bob@x.test\r\nSubject: Both parts\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{plain}\r\n--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n{html}\r\n--b--\r\n"
        )
        .into_bytes()
    }

    #[test]
    fn adapter_indexes_the_html_when_the_text_part_is_a_stub() {
        let html = "<p>Your <b>September statement</b> is ready.</p><p>Balance due: 1,240.00 by October 5.</p>";
        let doc = crate::search_index::index_doc_from_light(&eml_alternative("View this email in your browser", html), 1, "1:2,.eml").expect("parses");
        assert!(doc.body_text.contains("September statement"), "{:?}", doc.body_text);
        assert!(doc.body_text.contains("Balance due"), "{:?}", doc.body_text);
    }

    #[test]
    fn adapter_keeps_the_text_part_when_it_says_more_than_the_html() {
        let plain = "Hi Bob, the full minutes of Tuesday's meeting are below, with every action item and owner.";
        let doc = crate::search_index::index_doc_from_light(&eml_alternative(plain, "<p>See minutes</p>"), 1, "1:2,.eml").expect("parses");
        assert_eq!(doc.body_text.trim(), plain);
    }

    #[test]
    fn adapter_falls_back_to_html_when_the_text_part_is_whitespace() {
        let doc = crate::search_index::index_doc_from_light(&eml_alternative("  \r\n\t", "<p>From <b>html</b></p>"), 1, "1:2,.eml").expect("parses");
        assert_eq!(doc.body_text, "From html");
    }

    fn eml_with_one_attachment() -> Vec<u8> {
        b"From: Ann <ann@x.test>\r\nTo: bob@x.test\r\nSubject: Report attached\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSee attached.\r\n--b\r\nContent-Type: text/plain; name=\"notes.txt\"\r\nContent-Disposition: attachment; filename=\"notes.txt\"\r\n\r\nhello world\r\n--b--\r\n".to_vec()
    }

    /// C1: the real `ParseFn` must populate `attachment_candidates` from the
    /// message's actual MIME parts, not hardcode an empty Vec — that hardcode is
    /// what made the whole attachment-search feature inert in production (no
    /// pending row was ever written, so extraction never ran).
    #[test]
    fn adapter_lists_a_real_attachment_as_a_candidate() {
        let raw = eml_with_one_attachment();
        let doc = crate::search_index::index_doc_from_light(&raw, 1, "1:2,.eml").expect("parses");
        assert_eq!(doc.attachment_candidates.len(), 1, "{:?}", doc.attachment_candidates);
        let candidate = &doc.attachment_candidates[0];
        assert_eq!(candidate.filename, "notes.txt");
        assert_eq!(candidate.mime, "text/plain");
        // Size is the ENCODED part size (raw bytes, headers included) as an
        // upper bound on the decoded body, not the exact decoded length (I2):
        // this part is 7-bit so encoding adds no bloat, but the value comes from
        // `encoded_part_size`, never from decoding the body.
        let part_raw = b"Content-Type: text/plain; name=\"notes.txt\"\r\nContent-Disposition: attachment; filename=\"notes.txt\"\r\n\r\nhello world\r\n";
        assert_eq!(candidate.size, part_raw.len() as u64);
    }

    #[test]
    fn adapter_lists_no_candidates_for_a_message_with_no_attachments() {
        let doc = crate::search_index::index_doc_from_light(&eml_html(), 7, "7:2,S.eml").expect("parses");
        assert!(doc.attachment_candidates.is_empty(), "{:?}", doc.attachment_candidates);
    }

    #[test]
    fn assemble_rows_keeps_hit_order_and_adds_snippet_and_matched_in() {
        use mailvault_core::search_index::query::{SearchHit, SearchPage};
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for (dir, uid, subject, body) in [("INBOX", 3u32, "Budget", "the quarterly budget is attached"), ("Archive", 9, "Lunch", "no budget words here? budget!")] {
            let cur = root.join("Maildir/acct").join(dir).join("cur");
            std::fs::create_dir_all(&cur).unwrap();
            std::fs::write(cur.join(format!("{uid}:2,S.eml")), format!("From: A <a@x.test>\r\nTo: b@x.test\r\nSubject: {subject}\r\nDate: Sat, 12 Sep 2026 10:00:00 +0000\r\n\r\n{body}\r\n")).unwrap();
        }
        let page = SearchPage {
            hits: vec![
                SearchHit { vault_dir: "Archive".into(), uid: 9, filename: "9:2,S.eml".into(), message_id: None },
                SearchHit { vault_dir: "INBOX".into(), uid: 3, filename: "3:2,S.eml".into(), message_id: None },
                SearchHit { vault_dir: "INBOX".into(), uid: 404, filename: "404:2,.eml".into(), message_id: None },
            ],
            total: 3,
            needles: vec!["budget".into()],
        };
        let rows = crate::search_index::assemble_rows(root, "acct", &page);
        assert_eq!(rows.len(), 2, "a hit whose file vanished is dropped, not an error");
        assert_eq!(rows[0]["uid"], 9);
        assert_eq!(rows[0]["vaultDir"], "Archive");
        assert_eq!(rows[1]["uid"], 3);
        assert!(rows[1]["snippet"].as_str().unwrap().to_lowercase().contains("budget"));
        let matched: Vec<&str> = rows[1]["matchedIn"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
        assert!(matched.contains(&"subject") && matched.contains(&"body"));
        assert!(rows[0]["flags"].as_array().unwrap().iter().any(|f| f == "\\Seen"), "flags from the filename");

        // matchedIn reads names and addresses, not the JSON around them.
        let keys = SearchPage { needles: vec!["address".into()], ..page };
        let rows = crate::search_index::assemble_rows(root, "acct", &keys);
        assert!(rows.iter().all(|r| r["matchedIn"].as_array().unwrap().is_empty()), "{rows:?}");
        assert!(rows.iter().all(|r| r["snippet"].is_null()));
    }

    #[test]
    fn assemble_rows_drops_a_hit_whose_uid_now_holds_another_message() {
        use mailvault_core::search_index::query::{SearchHit, SearchPage};
        let tmp = tempfile::tempdir().unwrap();
        let cur = tmp.path().join("Maildir/acct/INBOX/cur");
        std::fs::create_dir_all(&cur).unwrap();
        for (uid, id) in [(5u32, "<reissued@x.test>"), (6, "<six@x.test>")] {
            std::fs::write(cur.join(format!("{uid}:2,.eml")), format!("From: a@x.test\r\nSubject: Budget {uid}\r\nMessage-ID: {id}\r\nDate: Sat, 12 Sep 2026 10:00:00 +0000\r\n\r\nbudget\r\n")).unwrap();
        }
        let hit = |uid: u32, id: &str| SearchHit { vault_dir: "INBOX".into(), uid, filename: format!("{uid}:2,.eml"), message_id: Some(id.into()) };
        // Indexed before a UID reissue repair gave uid 5 to another message.
        let page = SearchPage { hits: vec![hit(5, "<indexed@x.test>"), hit(6, "<six@x.test>")], total: 2, needles: vec!["budget".into()] };
        let rows = crate::search_index::assemble_rows(tmp.path(), "acct", &page);
        let uids: Vec<u64> = rows.iter().filter_map(|r| r["uid"].as_u64()).collect();
        assert_eq!(uids, vec![6], "the reissued uid's row is another message: dropped, never shown for this hit");
    }

    #[test]
    fn search_index_status_is_available_during_the_first_build_but_search_is_not() {
        use mailvault_core::search_index::{db, lock, query::SearchRequest};
        let tmp = tempfile::tempdir().unwrap();
        let st = crate::search_index::SearchIndexState::new(tmp.path().to_path_buf(), true, crate::events::EventBus::new(16));
        let status = || crate::search_index::status_json(&st);
        let search = || {
            let req = SearchRequest { account_id: "acct".into(), query: "budget".into(), ..Default::default() };
            crate::search_index::search_reply(&st, &req).unwrap()
        };
        assert_eq!((status()["available"].as_bool(), search()["available"].as_bool()), (Some(false), Some(false)), "closed");

        *lock(&st.db) = Some(db::open(tmp.path()).unwrap());
        *st.root.lock().unwrap() = Some(tmp.path().to_path_buf());
        let s = status();
        assert_eq!(s["available"], true, "open: Settings shows the first build's progress and can Rebuild");
        assert_eq!(s["indexed"], 0);
        assert_eq!(search()["available"], false, "a first build misses mail the scan finds: search keeps scanning");

        db::meta_set(lock(&st.db).as_ref().unwrap(), db::FIRST_PASS_DONE, "1").unwrap();
        let reply = search();
        assert_eq!(reply["available"], true);
        assert_eq!(reply["rows"], serde_json::json!([]));
        assert_eq!(status()["available"], true);
    }

    #[test]
    fn vault_rows_reads_flags_off_the_current_filename_and_skips_unindexed_uids() {
        use mailvault_core::search_index::{db, lock};
        let tmp = tempfile::tempdir().unwrap();
        let st = crate::search_index::SearchIndexState::new(tmp.path().to_path_buf(), true, crate::events::EventBus::new(16));
        assert!(crate::search_index::rows_reply(&st, "acct", "INBOX", &[3]).is_empty(), "closed: nothing, the caller reads the files");

        *lock(&st.db) = Some(db::open(tmp.path()).unwrap());
        {
            let guard = lock(&st.db);
            let conn = guard.as_ref().unwrap();
            // The row was parsed while the file was unread and unarchived; it has been renamed since.
            conn.execute(
                "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, date_utc, body_state, row_json) \
                 VALUES ('acct', 'INBOX', 3, '3:2,AS.eml', 1, 1, 1, 1, '{\"uid\":3,\"subject\":\"Budget\",\"isArchived\":false,\"hasAttachments\":true}')",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, date_utc, body_state, row_json) \
                 VALUES ('acct', 'Projects_2026', 5, '5:2,.eml', 1, 1, 1, 1, '{\"uid\":5,\"subject\":\"Nested\"}')",
                [],
            ).unwrap();
        }
        let rows = crate::search_index::rows_reply(&st, "acct", "INBOX", &[4, 3]);
        assert_eq!(rows.len(), 1, "uid 4 is not indexed: left to the file path");
        assert_eq!(rows[0]["uid"], 3);
        assert_eq!(rows[0]["subject"], "Budget");
        assert_eq!(rows[0]["hasAttachments"], true);
        assert_eq!(rows[0]["isArchived"], true, "from the current name, not the parse-time value");
        let flags: Vec<String> = rows[0]["flags"].as_array().unwrap().iter().map(|f| f.as_str().unwrap().to_string()).collect();
        assert!(flags.iter().any(|f| f == "\\Seen") && flags.iter().any(|f| f == "archived"), "{flags:?}");
        // The mailbox argument is the server path; the index keys by the sanitized dir.
        let nested = crate::search_index::rows_reply(&st, "acct", "Projects/2026", &[5]);
        assert_eq!(nested.len(), 1);
        assert_eq!(nested[0]["isArchived"], false);
        assert_eq!(nested[0]["flags"], serde_json::json!([]));
    }

    #[test]
    fn status_carries_first_pass_done() {
        use mailvault_core::search_index::{db, lock};
        let tmp = tempfile::tempdir().unwrap();
        let st = crate::search_index::SearchIndexState::new(tmp.path().to_path_buf(), true, crate::events::EventBus::new(16));
        assert_eq!(crate::search_index::status_json(&st)["firstPassDone"], false, "closed");
        *lock(&st.db) = Some(db::open(tmp.path()).unwrap());
        *st.root.lock().unwrap() = Some(tmp.path().to_path_buf());
        assert_eq!(crate::search_index::status_json(&st)["firstPassDone"], false);
        db::meta_set(lock(&st.db).as_ref().unwrap(), db::FIRST_PASS_DONE, "1").unwrap();
        assert_eq!(crate::search_index::status_json(&st)["firstPassDone"], true);
    }

    #[test]
    fn a_disabled_index_reports_off_and_search_unavailable() {
        use mailvault_core::search_index::{db, lock};
        let tmp = tempfile::tempdir().unwrap();
        let st = crate::search_index::SearchIndexState::new(tmp.path().to_path_buf(), true, crate::events::EventBus::new(16));
        // Open, root set and first pass done: the state search actually sees right
        // after configure-off or destroy, not a closed index that already answers
        // {available:false} on its own. Discriminates the `enabled` gate in
        // `search_reply` from the "no connection" branch it would fall through to.
        *lock(&st.db) = Some(db::open(tmp.path()).unwrap());
        *st.root.lock().unwrap() = Some(tmp.path().to_path_buf());
        db::meta_set(lock(&st.db).as_ref().unwrap(), db::FIRST_PASS_DONE, "1").unwrap();
        *st.enabled.lock().unwrap() = Some(false);
        let s = crate::search_index::status_json(&st);
        assert_eq!((s["available"].as_bool(), s["state"].as_str()), (Some(false), Some("off")));
        let req = mailvault_core::search_index::query::SearchRequest { account_id: "acct".into(), query: "x".into(), ..Default::default() };
        assert_eq!(crate::search_index::search_reply(&st, &req).unwrap()["available"], false);
    }

    /// Not a gate. The app parser over 50k ~3 KB multipart files, then what
    /// `vault_search` does per query (`search`, then `assemble_rows`), on a warm
    /// page cache (the files were just written). On the mini:
    /// cargo test -p mailvault-daemon --release search_index_bench -- --ignored --nocapture
    #[test]
    #[ignore]
    fn search_index_bench_50k_real_parser() {
        use mailvault_core::search_index::{db, lock, query::{search, SearchRequest}, reconcile::{self, IndexConfig}};
        use std::time::Instant;

        // splitmix64: which messages carry a word is set by its rate alone.
        fn mix(mut x: u64) -> u64 {
            x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
            x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            x ^ (x >> 31)
        }
        // No filler word contains a dictionary word, "update" or a digit.
        const FILLER: [&str; 32] = [
            "please", "review", "attached", "notes", "thanks", "regards", "schedule", "team", "project", "status",
            "follow", "question", "morning", "office", "travel", "weekend", "details", "summary", "action", "items",
            "customer", "product", "launch", "design", "draft", "final", "approve", "agenda", "call", "friday",
            "monday", "report",
        ];
        // (word, percent of messages whose body carries it)
        const DICT: [(&str, u64); 10] = [
            ("invoice", 5), ("meeting", 6), ("budget", 8), ("shipment", 3), ("contract", 4),
            ("会議", 3), ("資料", 2), ("Réunion", 1), ("delivery", 10), ("quarterly", 7),
        ];
        const N: u32 = 50_000;
        const NEWEST: i64 = 1_789_207_200; // Sat, 12 Sep 2026 10:00:00 +0000; message i is i*10 minutes older

        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let t = Instant::now();
        let mut bytes = 0usize;
        for i in 1..=N {
            let seed = u64::from(i) << 20;
            let mut words: Vec<&str> = (0..200).map(|k| FILLER[(mix(seed | k) % FILLER.len() as u64) as usize]).collect();
            for (k, (w, pct)) in DICT.iter().enumerate() {
                let k = k as u64;
                if mix(seed | (1000 + k)) % 100 < *pct {
                    let at = (mix(seed | (2000 + k)) % words.len() as u64) as usize;
                    words.insert(at, *w);
                }
            }
            let text = words.chunks(20).map(|c| c.join(" ")).collect::<Vec<_>>().join("\r\n");
            let html = words.chunks(20).map(|c| format!("<p>{}</p>", c.join(" "))).collect::<String>();
            let subject = FILLER[(mix(seed | 3000) % FILLER.len() as u64) as usize];
            let date = chrono::DateTime::from_timestamp(NEWEST - i64::from(i) * 600, 0).unwrap().to_rfc2822();
            let eml = format!(
                "From: Sender {s} <sender{s}@x.test>\r\nTo: Me <me@x.test>\r\nSubject: {subject} update {i}\r\nMessage-ID: <{i}@x.test>\r\nDate: {date}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{text}\r\n--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body>{html}</body></html>\r\n--b--\r\n",
                s = i % 50
            );
            bytes += eml.len();
            let cur = root.join("Maildir/bench").join(["INBOX", "Archive", "Sent"][(i % 3) as usize]).join("cur");
            std::fs::create_dir_all(&cur).unwrap();
            std::fs::write(cur.join(format!("{i}:2,S.eml")), eml).unwrap();
        }
        println!("corpus n={N} avg_bytes={} write={:?}", bytes / N as usize, t.elapsed());

        let db: mailvault_core::search_index::SharedConn = std::sync::Mutex::new(Some(db::open(root).unwrap()));
        let maildir = root.join("Maildir");
        let t = Instant::now();
        for (a, d) in reconcile::list_vault_dirs(&maildir).unwrap() {
            let parse = &crate::search_index::index_doc_from_light;
            reconcile::reconcile_mailbox(&db, &maildir, &a, &d, IndexConfig { bodies: true, attachments: true, image_text: true }, parse, &|| true, &mut |_| {}).unwrap();
        }
        println!("index_build n={N} elapsed={:?}", t.elapsed());
        {
            let g = lock(&db);
            let conn = g.as_ref().unwrap();
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
            let t = Instant::now();
            let c = db::counts(conn);
            println!("db_bytes={} counts indexed={} total={} elapsed={:?}", db::db_size_bytes(root), c.indexed, c.total, t.elapsed());
        }

        let req = |q: &str| SearchRequest { account_id: "bench".into(), query: q.into(), ..Default::default() };
        let week = SearchRequest { date_from: Some(NEWEST - 7 * 86_400), date_to: Some(NEWEST), ..req("") };
        for (label, r) in [("invoice", req("invoice")), ("budget meeting", req("budget meeting")), ("会議", req("会議")), ("update 4999", req("update 4999")), ("<empty>, last 7 days", week)] {
            let t = Instant::now();
            let page = search(lock(&db).as_ref().unwrap(), &r).unwrap();
            let searched = t.elapsed();
            let t = Instant::now();
            let rows = crate::search_index::assemble_rows(root, "bench", &page);
            println!("query {label:?} total={} hits={} rows={} search={searched:?} assemble={:?}", page.total, page.hits.len(), rows.len(), t.elapsed());
        }
    }
}
