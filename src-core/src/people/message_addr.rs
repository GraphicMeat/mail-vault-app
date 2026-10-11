//! One derived row per message and address. Kept in step with `header_cache`
//! by the write functions in `custody::cache` (same transaction), backfilled
//! for older vaults by `backfill_chunk`.
use rusqlite::{params, Connection};
use serde_json::Value;

fn err(e: rusqlite::Error) -> String { e.to_string() }

/// Lowercased bare address, or None when the text is not an address.
pub fn normalize(address: &str) -> Option<String> {
    let a = address.trim().trim_matches(|c: char| c == '<' || c == '>').trim().to_lowercase();
    (a.contains('@') && !a.chars().any(char::is_whitespace)).then_some(a)
}

/// Whether mail in this mailbox counts toward a contact's numbers. Archive
/// counts; trash, junk, drafts, outbox and templates do not. The leaf is read
/// off either delimiter (`/` or the `.` of Dovecot and cPanel: `INBOX.Trash`).
/// Gmail's All Mail and Important are NOT excluded: counts dedupe by `msg_key`,
/// and Gmail-archived mail may live only in All Mail.
pub fn counts_mailbox(mailbox: &str) -> bool {
    let lower = mailbox.to_lowercase();
    let leaf = lower.rsplit(|c: char| c == '/' || c == '.').next().unwrap_or(&lower).trim();
    let excluded_leaf = matches!(
        leaf,
        "trash" | "deleted" | "deleted items" | "deleted messages" | "junk" | "junk e-mail" | "junk email"
            | "spam" | "bulk" | "drafts" | "draft" | "outbox" | "templates"
    );
    !(excluded_leaf
        || lower.starts_with("[gmail]/trash")
        || lower.starts_with("[gmail]/spam")
        || lower.starts_with("[gmail]/drafts"))
}

/// The per-account identity of a message across folders: its Message-ID, else
/// `u:{mailbox}:{uid}` (`app_db::identity::msg_key`).
fn key_of(header: &Value, mailbox: &str, uid: u32) -> String {
    let id = header.get("messageId").or_else(|| header.get("message_id")).and_then(Value::as_str);
    crate::app_db::identity::msg_key(id, mailbox, uid)
}

fn collect(header: &Value) -> Vec<(&'static str, String, String)> {
    let mut out = Vec::new();
    let mut push = |role: &'static str, v: &Value| {
        let Some(addr) = v.get("address").and_then(Value::as_str).and_then(normalize) else { return };
        let name = v.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
        out.push((role, addr, name));
    };
    if let Some(f) = header.get("from") { push("from", f); }
    for role in ["to", "cc", "bcc"] {
        if let Some(list) = header.get(role).and_then(Value::as_array) {
            for v in list { push(role, v); }
        }
    }
    out
}

pub fn forget_row(conn: &Connection, account: &str, mailbox: &str, uid: u32) -> Result<(), String> {
    conn.prepare_cached("DELETE FROM message_addr WHERE account_id=?1 AND mailbox_path=?2 AND uid=?3")
        .map_err(err)?
        .execute(params![account, mailbox, uid])
        .map_err(err)?;
    Ok(())
}

pub fn index_row(conn: &Connection, account: &str, mailbox: &str, uid: u32, sort_ms: i64, header: &Value) -> Result<(), String> {
    forget_row(conn, account, mailbox, uid)?;
    let counted = counts_mailbox(mailbox) as i64;
    let key = key_of(header, mailbox, uid);
    let mut stmt = conn
        .prepare_cached(
            "INSERT OR REPLACE INTO message_addr(account_id,mailbox_path,uid,address,role,name,sort_ms,counted,msg_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        )
        .map_err(err)?;
    for (role, addr, name) in collect(header) {
        stmt.execute(params![account, mailbox, uid, addr, role, name, sort_ms, counted, key]).map_err(err)?;
    }
    Ok(())
}

pub fn forget_mailbox(conn: &Connection, account: Option<&str>, mailbox: Option<&str>) -> Result<(), String> {
    match (account, mailbox) {
        (Some(a), Some(m)) => conn.execute("DELETE FROM message_addr WHERE account_id=?1 AND mailbox_path=?2", params![a, m]),
        (Some(a), None) => conn.execute("DELETE FROM message_addr WHERE account_id=?1", [a]),
        (None, _) => conn.execute("DELETE FROM message_addr", []),
    }
    .map_err(err)?;
    Ok(())
}

pub fn rename_mailbox(conn: &Connection, account: &str, from: &str, to: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE OR REPLACE message_addr SET mailbox_path=?3, counted=?4 WHERE account_id=?1 AND mailbox_path=?2",
        params![account, from, to, counts_mailbox(to) as i64],
    )
    .map_err(err)?;
    Ok(())
}

use crate::custody::db::{meta_get, meta_set};

pub const DONE_KEY: &str = "message_addr_backfilled";
const CURSOR_KEY: &str = "message_addr_cursor";
const SEP: char = '\u{1f}';

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    pub indexed: u64,
    pub done: bool,
}

pub fn backfill_done(conn: &Connection) -> bool {
    meta_get(conn, DONE_KEY).as_deref() == Some("1")
}

fn parse_cursor(s: &str) -> Option<(String, String, u32)> {
    let mut it = s.split(SEP);
    Some((it.next()?.to_string(), it.next()?.to_string(), it.next()?.parse().ok()?))
}

/// Index up to `limit` header rows from ONE mailbox and move the cursor. The
/// caller holds the custody lock for this one call only, so the work is a small
/// unit by construction. Live writes and this backfill both use `index_row`,
/// which replaces, so the overlap is harmless.
pub fn backfill_chunk(conn: &Connection, limit: usize) -> Result<Progress, String> {
    if backfill_done(conn) {
        return Ok(Progress { indexed: 0, done: true });
    }
    let mut boxes = crate::custody::cache::mailboxes_with_headers(conn, None)?;
    boxes.sort();
    let cursor = meta_get(conn, CURSOR_KEY).and_then(|s| parse_cursor(&s));
    let mut start = 0;
    let mut after_uid = 0u32;
    if let Some((a, m, uid)) = &cursor {
        match boxes.iter().position(|(ba, bm)| (ba, bm) >= (a, m)) {
            Some(i) => {
                start = i;
                if boxes[i].0 == *a && boxes[i].1 == *m { after_uid = *uid; }
            }
            None => start = boxes.len(),
        }
    }
    let mut i = start;
    while i < boxes.len() {
        let (account, mailbox) = &boxes[i];
        let rows: Vec<(u32, i64, String)> = {
            let mut stmt = conn
                .prepare_cached("SELECT uid, sort_ms, header_json FROM header_cache WHERE account_id=?1 AND mailbox_path=?2 AND uid>?3 ORDER BY uid LIMIT ?4")
                .map_err(err)?;
            let mapped = stmt
                .query_map(params![account, mailbox, after_uid, limit as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map_err(err)?;
            mapped.collect::<Result<_, _>>().map_err(err)?
        };
        if rows.is_empty() {
            i += 1;
            after_uid = 0;
            continue;
        }
        let tx = conn.unchecked_transaction().map_err(err)?;
        let mut last = after_uid;
        for (uid, sort_ms, json) in &rows {
            if let Ok(h) = serde_json::from_str::<Value>(json) {
                index_row(&tx, account, mailbox, *uid, *sort_ms, &h)?;
            }
            last = *uid;
        }
        meta_set(&tx, CURSOR_KEY, &format!("{account}{SEP}{mailbox}{SEP}{last}"))?;
        tx.commit().map_err(err)?;
        return Ok(Progress { indexed: rows.len() as u64, done: false });
    }
    meta_set(conn, DONE_KEY, "1")?;
    conn.execute("DELETE FROM meta WHERE key=?1", [CURSOR_KEY]).map_err(err)?;
    Ok(Progress { indexed: 0, done: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custody::db;
    use serde_json::json;

    fn conn() -> (tempfile::TempDir, Connection) {
        let tmp = tempfile::tempdir().unwrap();
        let c = db::open(tmp.path()).unwrap();
        (tmp, c)
    }
    fn header() -> Value {
        json!({
            "uid": 7,
            "from": {"name": "Alice A", "address": " <Alice@Example.COM> "},
            "to": [{"name": null, "address": "me@home.org"}, {"address": "bob@x.io"}],
            "cc": [{"address": "carol@x.io"}],
            "bcc": []
        })
    }

    #[test]
    fn normalize_handles_case_brackets_and_junk() {
        assert_eq!(normalize(" <Alice@Example.COM> ").as_deref(), Some("alice@example.com"));
        assert_eq!(normalize("not an address"), None);
        assert_eq!(normalize(""), None);
    }

    #[test]
    fn counts_mailbox_excludes_junk_trash_drafts_but_keeps_archive() {
        for m in ["INBOX", "Sent", "Archive", "Work/Clients", "INBOX.Sent Items", "[Gmail]/All Mail", "[Gmail]/Important"] {
            assert!(counts_mailbox(m), "{m}");
        }
        for m in ["Trash", "Junk E-mail", "Spam", "Drafts", "[Gmail]/Trash", "[Gmail]/Spam", "[Gmail]/Drafts", "Deleted Items", "Work/Trash", "INBOX.Trash", "INBOX.Junk"] {
            assert!(!counts_mailbox(m), "{m}");
        }
    }

    #[test]
    fn msg_key_is_the_message_id_or_falls_back_to_mailbox_and_uid() {
        let (_t, c) = conn();
        index_row(&c, "acc", "INBOX", 7, 1000, &json!({"uid": 7, "messageId": "<abc@x>", "from": {"address": "a@x.io"}})).unwrap();
        index_row(&c, "acc", "Work", 9, 1000, &json!({"uid": 9, "message_id": "abc@x", "from": {"address": "a@x.io"}})).unwrap();
        index_row(&c, "acc", "INBOX", 8, 1000, &json!({"uid": 8, "from": {"address": "a@x.io"}})).unwrap();
        let keys: Vec<String> = c.prepare("SELECT DISTINCT msg_key FROM message_addr ORDER BY msg_key").unwrap()
            .query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(keys, ["abc@x", "u:INBOX:8"], "the same Message-ID in two folders is one key; no id falls back to mailbox and uid");
    }

    #[test]
    fn index_row_writes_one_row_per_role_and_address() {
        let (_t, c) = conn();
        index_row(&c, "acc", "INBOX", 7, 1000, &header()).unwrap();
        let n: i64 = c.query_row("SELECT count(*) FROM message_addr", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 4);
        let a: String = c.query_row("SELECT address FROM message_addr WHERE role='from'", [], |r| r.get(0)).unwrap();
        assert_eq!(a, "alice@example.com");
    }

    #[test]
    fn re_indexing_a_replaced_header_leaves_no_stale_rows() {
        let (_t, c) = conn();
        index_row(&c, "acc", "INBOX", 7, 1000, &header()).unwrap();
        index_row(&c, "acc", "INBOX", 7, 1000, &json!({"uid": 7, "from": {"address": "z@z.io"}})).unwrap();
        let n: i64 = c.query_row("SELECT count(*) FROM message_addr", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn trash_rows_are_stored_but_not_counted() {
        let (_t, c) = conn();
        index_row(&c, "acc", "Trash", 1, 5, &header()).unwrap();
        let counted: i64 = c.query_row("SELECT max(counted) FROM message_addr", [], |r| r.get(0)).unwrap();
        assert_eq!(counted, 0);
    }

    #[test]
    fn rename_mailbox_moves_rows_and_recomputes_counted() {
        let (_t, c) = conn();
        index_row(&c, "acc", "Old", 1, 5, &header()).unwrap();
        rename_mailbox(&c, "acc", "Old", "Trash").unwrap();
        let (mb, counted): (String, i64) = c.query_row("SELECT mailbox_path, max(counted) FROM message_addr", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((mb.as_str(), counted), ("Trash", 0));
    }

    #[test]
    fn forget_mailbox_scopes() {
        let (_t, c) = conn();
        index_row(&c, "a", "INBOX", 1, 5, &header()).unwrap();
        index_row(&c, "a", "Sent", 1, 5, &header()).unwrap();
        index_row(&c, "b", "INBOX", 1, 5, &header()).unwrap();
        forget_mailbox(&c, Some("a"), Some("INBOX")).unwrap();
        let n: i64 = c.query_row("SELECT count(DISTINCT account_id||mailbox_path) FROM message_addr", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
        forget_mailbox(&c, None, None).unwrap();
        let n: i64 = c.query_row("SELECT count(*) FROM message_addr", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    fn seed_headers(c: &Connection, mailbox: &str, n: u32) {
        let tx = c.unchecked_transaction().unwrap();
        for uid in 1..=n {
            let h = json!({"uid": uid, "from": {"address": format!("s{uid}@x.io")}, "to": [{"address": "me@h.io"}]});
            tx.execute(
                "INSERT INTO header_cache(account_id,mailbox_path,uid,sort_ms,updated_ms,header_json) VALUES ('a',?1,?2,?3,0,?4)",
                params![mailbox, uid, 1000 + uid as i64, h.to_string()],
            ).unwrap();
        }
        tx.commit().unwrap();
    }

    #[test]
    fn backfill_runs_in_bounded_chunks_to_completion() {
        let (_t, c) = conn();
        seed_headers(&c, "INBOX", 1200);
        seed_headers(&c, "Sent", 10);
        let mut calls = 0;
        loop {
            let p = backfill_chunk(&c, 500).unwrap();
            calls += 1;
            assert!(p.indexed <= 500, "a chunk never exceeds its limit");
            if p.done { break; }
            assert!(calls < 20);
        }
        assert!(backfill_done(&c));
        let n: i64 = c.query_row("SELECT count(*) FROM message_addr", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2 * 1210);
        assert!(calls >= 4, "1200 rows need at least three chunks plus the second mailbox");
    }

    #[test]
    fn backfill_resumes_after_an_interruption_and_is_idempotent() {
        let (_t, c) = conn();
        seed_headers(&c, "INBOX", 700);
        backfill_chunk(&c, 500).unwrap();
        // simulate a crash: a live write re-indexes a row already done
        index_row(&c, "a", "INBOX", 3, 1003, &json!({"uid": 3, "from": {"address": "s3@x.io"}, "to": [{"address": "me@h.io"}]})).unwrap();
        while !backfill_chunk(&c, 500).unwrap().done {}
        let n: i64 = c.query_row("SELECT count(*) FROM message_addr", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1400);
    }

    #[test]
    fn a_finished_backfill_stays_finished() {
        let (_t, c) = conn();
        assert!(backfill_chunk(&c, 500).unwrap().done);
        seed_headers(&c, "INBOX", 5);
        let p = backfill_chunk(&c, 500).unwrap();
        assert!(p.done && p.indexed == 0);
    }
}
