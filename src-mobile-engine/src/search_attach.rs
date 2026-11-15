//! Attachment text in the phone's search index (Settings > Search index, "Index attachment
//! text", `searchIndexAttachments`, Premium as on desktop). Only parts the phone has downloaded
//! (`attachments.rs`: the cache, or the offline files) are read; nothing is fetched for the index.
//! Core's extraction (`search_index::attachments::extract`) reads text-like parts (txt, csv, html,
//! ...) and Office documents (docx, xlsx, pptx) in pure Rust; a PDF or an image needs a platform
//! extractor the phone does not have, so those parts are not read at all.
//!
//! What a part gave is recorded in `search.db` (`writer::record_attachment`, keyed by the part's
//! section, [`part_key`]), and the message is written again so its text is
//! searchable; every later write of the message keeps it. A part already recorded is never read
//! again. Runs on the index worker only: a part that finished downloading is a job
//! ([`crate::search::attachment_ready`]), and a sweep over every downloaded part runs after the
//! backfill (at start, after a rebuild, when the setting or Premium changes), a few parts per unit.

use crate::db::Shared;
use crate::search;
use mailvault_core::search_index::attachments::{self as core_att, AttachmentInput, NoOcrExtractor};
use mailvault_core::search_index::{self, writer};
use rusqlite::OptionalExtension;
use std::path::PathBuf;

/// Rows of `mobile.db` `attachments` one sweep unit looks at.
const SWEEP_ROWS: i64 = 50;
/// Parts one sweep unit reads at most.
const SWEEP_READS: usize = 4;

/// Attachment text is on (`searchIndexAttachments`, on unless turned off) and Premium is.
pub(crate) fn enabled(shared: &Shared) -> bool {
    let on = shared.read(|c| crate::settings::get_in(c, "searchIndexAttachments")).ok().flatten().as_deref() != Some("false");
    on && crate::premium::active(shared)
}

/// A part core reads without a platform extractor.
fn readable(mime: &str, filename: &str) -> bool {
    core_att::is_text_like(mime, filename) || core_att::is_office(mime, filename)
}

/// One `mobile.db` attachment row.
struct Part {
    account: String,
    folder: String,
    uid: u32,
    section: String,
    filename: String,
    mime: String,
    size: u64,
}

/// The downloaded file of a part: the offline files first, then the cache (not touched: reading
/// it for the index is not opening it).
fn file_of(shared: &Shared, p: &Part) -> Option<PathBuf> {
    let name = crate::attachments::part_name(shared, &p.account, &p.folder, p.uid, &p.section)?;
    if let Some(f) = crate::offline::attachments_dir(shared, &p.account).map(|d| d.join(&name)).filter(|f| f.is_file()) {
        return Some(f);
    }
    shared.search.att_dir.get().map(|d| d.join(&name)).filter(|f| f.is_file())
}

/// The `part_index` a part's record is kept under in `search.db`: its section, so the record
/// follows the part whatever rows the message gains or loses. A section of up to four numbers
/// (the first under 128, the rest under 256, as every real one is) is packed a byte each, in
/// section order; any other spelling is a hash with the top bit set, so the two never meet.
pub(crate) fn part_key(section: &str) -> u32 {
    let nums: Option<Vec<u32>> = section.split('.').map(|n| n.parse::<u32>().ok()).collect();
    if let Some(nums) = nums.filter(|n| (1..=4).contains(&n.len()) && n[0] < 128 && n.iter().all(|&x| x < 256)) {
        return nums.iter().enumerate().fold(0u32, |k, (i, &x)| k | (x << (24 - 8 * i)));
    }
    use sha2::{Digest, Sha256};
    let h = Sha256::digest(section.as_bytes());
    u32::from_be_bytes([h[0], h[1], h[2], h[3]]) | 0x8000_0000
}

/// Indexes one part's text if it is readable, downloaded and not recorded yet. Returns whether it
/// read a file.
fn index_part(shared: &Shared, p: &Part) -> Result<bool, String> {
    if !readable(&p.mime, &p.filename) {
        return Ok(false);
    }
    let index = part_key(&p.section);
    {
        let guard = search_index::lock(&shared.search.conn);
        let Some(c) = guard.as_ref() else { return Ok(false) };
        if writer::attachment_state(c, &p.account, &p.folder, p.uid, index)?.is_some() {
            return Ok(false);
        }
    }
    let Some(path) = file_of(shared, p) else { return Ok(false) };
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(p.size);
    let bytes = if size > core_att::MAX_PART_BYTES { Vec::new() } else { std::fs::read(&path).map_err(|e| e.to_string())? };
    let input = AttachmentInput { filename: p.filename.clone(), mime: p.mime.clone(), size, bytes };
    let (state, text) = core_att::extract(&input, true, true, &NoOcrExtractor);
    if state == "pending" {
        // Transient: the next sweep tries again.
        return Ok(true);
    }
    // The message as it is now, read before the search lock is taken.
    let docs = search::read_docs(shared, &p.account, &p.folder, &[p.uid]).map_err(|e| e.to_string())?;
    let guard = search_index::lock(&shared.search.conn);
    let Some(c) = guard.as_ref() else { return Ok(true) };
    // Two commits under one hold of the lock: a record whose message write failed is searchable
    // with the message's next write.
    if writer::record_attachment(c, &p.account, &p.folder, p.uid, index, &p.filename, &p.mime, size, state, text.as_deref())? {
        search::write_docs(c, &p.account, &p.folder, &docs, false, None)?;
    }
    Ok(true)
}

fn part_row(r: &rusqlite::Row) -> rusqlite::Result<Part> {
    Ok(Part {
        account: r.get(0)?,
        folder: r.get(1)?,
        uid: r.get::<_, i64>(2)? as u32,
        section: r.get(3)?,
        filename: r.get(4)?,
        mime: r.get(5)?,
        size: r.get::<_, i64>(6)?.max(0) as u64,
    })
}

/// The index worker's job for a part that finished downloading.
pub(crate) fn extract_one(shared: &Shared, account: &str, folder: &str, uid: u32, section: &str) {
    if !enabled(shared) {
        return;
    }
    let part = shared.read(|c| {
        c.query_row(
            "SELECT account_id, folder, uid, section, filename, mime, size FROM attachments
             WHERE account_id = ?1 AND folder = ?2 AND uid = ?3 AND section = ?4",
            (account, folder, uid as i64, section),
            part_row,
        )
        .optional()
    });
    match part {
        Ok(Some(p)) => {
            if let Err(e) = index_part(shared, &p) {
                shared.log(&format!("[search] attachment text: {e}"));
            }
        }
        Ok(None) => {}
        Err(e) => shared.log(&format!("[search] reading an attachment row: {e}")),
    }
}

/// The sweep over every attachment row, in key order, resumable within a run.
#[derive(Default)]
pub(crate) struct Sweep {
    after: Option<(String, String, i64, String)>,
    pub(crate) done: bool,
}

impl Sweep {
    /// One unit: up to [`SWEEP_ROWS`] rows looked at, up to [`SWEEP_READS`] files read.
    pub(crate) fn step(&mut self, shared: &Shared) -> Result<(), String> {
        if !enabled(shared) {
            self.done = true;
            return Ok(());
        }
        let (a, f, u, s) = self.after.clone().unwrap_or((String::new(), String::new(), -1, String::new()));
        let rows: Vec<Part> = shared
            .read(|c| {
                let mut st = c.prepare_cached(
                    "SELECT a.account_id, a.folder, a.uid, a.section, a.filename, a.mime, a.size FROM attachments a
                     WHERE (a.account_id, a.folder, a.uid, a.section) > (?1, ?2, ?3, ?4)
                     ORDER BY a.account_id, a.folder, a.uid, a.section LIMIT ?5",
                )?;
                let rows = st.query_map((&a, &f, u, &s, SWEEP_ROWS), part_row)?.collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .map_err(|e| e.to_string())?;
        if rows.is_empty() {
            self.done = true;
            return Ok(());
        }
        let mut reads = 0;
        for p in rows {
            self.after = Some((p.account.clone(), p.folder.clone(), p.uid as i64, p.section.clone()));
            if index_part(shared, &p)? {
                reads += 1;
                if reads >= SWEEP_READS {
                    break;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Engine, MemorySecrets};
    use serde_json::json;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    fn idle(e: &Engine) {
        let deadline = Instant::now() + Duration::from_secs(60);
        while !e.search_idle() {
            assert!(Instant::now() < deadline, "the index never went idle");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn found(e: &Engine, q: &str) -> Vec<u64> {
        let page = e.rpc("mobile.search.local", json!({ "query": q })).unwrap();
        page["rows"].as_array().unwrap().iter().map(|r| r["uid"].as_u64().unwrap()).collect()
    }

    /// A message with a text part (downloaded), an Office-shaped part not downloaded, and a PDF
    /// (downloaded, never read).
    fn engine(tmp: &tempfile::TempDir) -> Engine {
        let e = Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(MemorySecrets::default())).unwrap();
        e.write(|c| {
            c.execute(
                "INSERT INTO accounts (id, email, display_name, imap_host, imap_port, security, created_ms)
                 VALUES ('acc', 'acc@example.test', 'U', 'imap.example.test', 993, 'ssl', 1)",
                [],
            )?;
            c.execute("INSERT INTO folders (account_id, path, name, uid_validity) VALUES ('acc', 'INBOX', 'INBOX', 7)", [])?;
            for uid in [1i64, 2] {
                c.execute(
                    "INSERT INTO messages (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged, has_attachments, message_id)
                     VALUES ('acc', 'INBOX', ?1, ?2, 'Ada', 'ada@example.test', 1700000000000, '', 0, 0, 1, ?3)",
                    (uid, format!("parts {uid}"), format!("<p{uid}@x>")),
                )?;
            }
            for (uid, section, name, mime) in [
                (1i64, "2", "notes.txt", "text/plain"),
                (1, "3", "plan.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
                (2, "2", "scan.pdf", "application/pdf"),
            ] {
                c.execute(
                    "INSERT INTO attachments (account_id, folder, uid, section, filename, mime, size, encoding) VALUES ('acc', 'INBOX', ?1, ?2, ?3, ?4, 30, 'base64')",
                    (uid, section, name, mime),
                )?;
            }
            Ok(())
        })
        .unwrap();
        e
    }

    fn put_file(e: &Engine, uid: u32, section: &str, bytes: &[u8]) {
        let name = crate::attachments::part_name(e.shared(), "acc", "INBOX", uid, section).unwrap();
        let dir = e.shared().search.att_dir.get().unwrap().clone();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(name), bytes).unwrap();
    }

    #[test]
    fn downloaded_text_parts_are_indexed_with_premium_and_leave_when_switched_off() {
        let tmp = tempfile::tempdir().unwrap();
        let e = engine(&tmp);
        put_file(&e, 1, "2", b"the kumquat orchard ledger");
        put_file(&e, 2, "2", b"%PDF-1.4 kumquat");
        idle(&e);
        assert!(found(&e, "kumquat").is_empty(), "attachment text without Premium");

        crate::premium::set_active_for_test(e.shared(), true);
        crate::search::wake(e.shared());
        idle(&e);
        let s = e.rpc("mobile.search.status", json!({})).unwrap();
        let rows: Vec<(u32, String)> = e.search_index_rows("acc", "INBOX");
        assert_eq!(found(&e, "kumquat"), vec![1], "the text part is searchable; the PDF is never read: {s} {rows:?} enabled={}", enabled(e.shared()));
        assert_eq!(s["attachments"], 1, "{s}");

        // A part that finishes downloading later is indexed by its job.
        put_file(&e, 1, "3", b"not a zip");
        crate::search::attachment_ready(e.shared(), "acc", "INBOX", 1, "3");
        idle(&e);
        let recorded = |e: &Engine| {
            let g = search_index::lock(&e.shared().search.conn);
            writer::attachment_state(g.as_ref().unwrap(), "acc", "INBOX", 1, part_key("3")).unwrap()
        };
        assert!(recorded(&e).is_some_and(|s| s != "ok"), "a broken docx is recorded, not retried");

        // Switched off: its text leaves the index.
        e.rpc("mobile.prefs.set", json!({ "searchIndexAttachments": false })).unwrap();
        idle(&e);
        assert!(found(&e, "kumquat").is_empty());
        assert_eq!(e.rpc("mobile.search.status", json!({})).unwrap()["attachments"], 0);
        // And back on: the sweep reads the downloaded part again.
        e.rpc("mobile.prefs.set", json!({ "searchIndexAttachments": true })).unwrap();
        idle(&e);
        assert_eq!(found(&e, "kumquat"), vec![1]);
    }

    /// A part's record follows its section, not its place among the rows: when a message's parts
    /// are listed again (one gone, a new one with a section that sorts before the rest as text),
    /// the new part is still read.
    #[test]
    fn a_new_part_is_read_when_the_rows_around_it_change() {
        let tmp = tempfile::tempdir().unwrap();
        let e = engine(&tmp);
        crate::premium::set_active_for_test(e.shared(), true);
        put_file(&e, 1, "2", b"the kumquat orchard ledger");
        crate::search::wake(e.shared());
        idle(&e);
        assert_eq!(found(&e, "kumquat"), vec![1]);

        e.write(|c| {
            c.execute("DELETE FROM attachments WHERE account_id = 'acc' AND uid = 1 AND section = '2'", [])?;
            c.execute(
                "INSERT INTO attachments (account_id, folder, uid, section, filename, mime, size, encoding)
                 VALUES ('acc', 'INBOX', 1, '15', 'grove.txt', 'text/plain', 30, 'base64')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        put_file(&e, 1, "15", b"a mango grove survey");
        crate::search::attachment_ready(e.shared(), "acc", "INBOX", 1, "15");
        idle(&e);
        assert_eq!(found(&e, "mango"), vec![1], "the new part was taken for one already recorded");
    }

    #[test]
    fn part_keys_are_stable_and_distinct() {
        assert_eq!(part_key("2"), part_key("2"));
        let keys: std::collections::HashSet<u32> = ["1", "2", "10", "15", "2.1", "2.10", "1.2.3", "TEXT"].iter().map(|s| part_key(s)).collect();
        assert_eq!(keys.len(), 8);
    }
}
