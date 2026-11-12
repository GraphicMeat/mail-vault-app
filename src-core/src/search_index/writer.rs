//! Writing the index with no vault: for a caller that holds mail in its own
//! store (the phone's `mobile.db`) and keeps the index in its own file
//! (`db::open_at`). Rows are built by the same `reconcile::write_row` the
//! vault reconcile uses, so `query::search` reads them exactly like desktop's.
//!
//! The folder key goes through `text::vault_dir_name` on the way in, the same
//! mapping `query::search` applies to `SearchRequest.mailboxes`, so a search
//! scoped to `[folder]` finds what `index_doc(.., folder, ..)` wrote.
//! `SearchHit.vault_dir` comes back in that sanitized form.

use super::reconcile::{delete_fts, write_row, IndexDoc, RowPlace, BODY_INDEXED, BODY_PENDING, UPSERT};
use super::text::vault_dir_name;
use rusqlite::{params, Connection};

/// Add or replace one message. Replaces every column and every search term,
/// body included: a doc with an empty `body_text` leaves the row with no body
/// terms (`body_state` pending, no preview line). For a flag change alone use
/// `set_flags`, which keeps the body.
///
/// `flags` are the message's flags in any spelling `message_store::flag_letters`
/// reads (`seen`/`S`, `flagged`/`F`, ...); they are stored as letters, which is
/// what the `unread`/`starred`/`answered` filters read. The file name is `''`
/// and size and mtime are 0: there is no file. A doc with no date is dated now,
/// never 1970.
pub fn index_doc(conn: &Connection, account_id: &str, folder_key: &str, uid: u32, doc: &IndexDoc, flags: &[String]) -> Result<(), String> {
    let vault_dir = vault_dir_name(folder_key);
    let letters = crate::message_store::flag_letters(flags);
    let place = RowPlace { account_id, vault_dir: &vault_dir, uid, filename: "", size: 0, mtime_ns: 0, flags: &letters };
    let (body_state, snippet) = if doc.body_text.is_empty() {
        (BODY_PENDING, None)
    } else {
        (BODY_INDEXED, Some(super::reconcile::snippet_of(&doc.body_text)))
    };
    let date_utc = doc.date_utc.unwrap_or_else(|| crate::clock::now_secs());
    let mut doc = doc.clone();
    doc.body_text = super::text::cap_chars(doc.body_text, super::reconcile::MAX_BODY_CHARS);
    in_savepoint(conn, |conn| {
        let mut upsert = conn.prepare_cached(UPSERT)?;
        write_row(conn, &mut upsert, &place, &doc, date_utc, body_state, snippet).map(|_| ())
    })
}

/// Replace one message's flags, keeping its row and search terms. A uid the
/// index does not hold is a no-op.
pub fn set_flags(conn: &Connection, account_id: &str, folder_key: &str, uid: u32, flags: &[String]) -> Result<(), String> {
    conn.prepare_cached("UPDATE messages SET flags = ?4 WHERE account_id = ?1 AND vault_dir = ?2 AND uid = ?3")
        .and_then(|mut st| st.execute(params![account_id, vault_dir_name(folder_key), uid, crate::message_store::flag_letters(flags)]))
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Remove one message and its search terms. A uid the index does not hold is a no-op.
pub fn forget(conn: &Connection, account_id: &str, folder_key: &str, uid: u32) -> Result<(), String> {
    let vault_dir = vault_dir_name(folder_key);
    in_savepoint(conn, |conn| {
        let ids: Vec<i64> = conn
            .prepare_cached("SELECT id FROM messages WHERE account_id = ?1 AND vault_dir = ?2 AND uid = ?3")?
            .query_map(params![account_id, vault_dir, uid], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for id in ids {
            remove_row(conn, id)?;
        }
        Ok(())
    })
}

/// Remove every message of one folder and its search terms: a folder deleted,
/// or its UIDVALIDITY reset.
pub fn forget_folder(conn: &Connection, account_id: &str, folder_key: &str) -> Result<(), String> {
    let vault_dir = vault_dir_name(folder_key);
    in_savepoint(conn, |conn| {
        let scope = params![account_id, vault_dir];
        // Attachments explicitly: a caller's connection may not have foreign keys on.
        for sql in [
            "DELETE FROM msg_fts WHERE rowid IN (SELECT id FROM messages WHERE account_id = ?1 AND vault_dir = ?2)",
            "DELETE FROM msg_cjk WHERE rowid IN (SELECT id FROM messages WHERE account_id = ?1 AND vault_dir = ?2)",
            "DELETE FROM attachments WHERE message_row IN (SELECT id FROM messages WHERE account_id = ?1 AND vault_dir = ?2)",
            "DELETE FROM messages WHERE account_id = ?1 AND vault_dir = ?2",
            "DELETE FROM mailbox_scan WHERE account_id = ?1 AND vault_dir = ?2",
        ] {
            conn.execute(sql, scope)?;
        }
        Ok(())
    })
}

/// Run `f` all or nothing. A savepoint, not a transaction: it nests inside a
/// transaction the caller holds, so a caller can write a whole chunk of rows
/// in one commit of its own.
fn in_savepoint(conn: &Connection, f: impl FnOnce(&Connection) -> rusqlite::Result<()>) -> Result<(), String> {
    conn.execute_batch("SAVEPOINT search_writer").map_err(|e| e.to_string())?;
    match f(conn) {
        Ok(()) => conn.execute_batch("RELEASE search_writer").map_err(|e| e.to_string()),
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK TO search_writer; RELEASE search_writer");
            Err(e.to_string())
        }
    }
}

fn remove_row(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    delete_fts(conn, id)?;
    conn.prepare_cached("DELETE FROM attachments WHERE message_row = ?1")?.execute([id])?;
    conn.prepare_cached("DELETE FROM messages WHERE id = ?1")?.execute([id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search_index::db::open_at;
    use crate::search_index::query::{search, SearchRequest};

    fn doc(subject: &str, from: &str, body: &str) -> IndexDoc {
        IndexDoc {
            message_id: Some(format!("<{subject}@test>")),
            date_utc: Some(1_700_000_000),
            from_addr: from.into(),
            from_name: String::new(),
            addrs: vec![from.into(), "me@phone.test".into()],
            to_addrs: vec!["me@phone.test".into()],
            subject: subject.into(),
            body_text: body.into(),
            row_json: "{}".into(),
            ..IndexDoc::default()
        }
    }

    fn uids(conn: &Connection, req: SearchRequest) -> Vec<u32> {
        let mut found: Vec<u32> = search(conn, &req).unwrap().hits.into_iter().map(|h| h.uid).collect();
        found.sort_unstable();
        found
    }

    fn q(query: &str) -> SearchRequest {
        SearchRequest { account_id: "acc".into(), query: query.into(), ..Default::default() }
    }

    fn seed() -> (tempfile::TempDir, Connection) {
        let tmp = tempfile::tempdir().unwrap();
        // No vault: just a file beside where the phone keeps mobile.db.
        let conn = open_at(&tmp.path().join("search.db")).unwrap();
        let none: &[String] = &[];
        index_doc(&conn, "acc", "INBOX", 1, &doc("Café meeting", "anna@x.test", "Let us meet at the café near the station."), none).unwrap();
        index_doc(&conn, "acc", "INBOX", 2, &doc("会議の議事録", "taro@x.test", "東京で会議があります"), &["seen".into()]).unwrap();
        index_doc(&conn, "acc", "[Gmail]/All Mail", 3, &doc("Quarterly invoice", "billing@acme.test", "He said \"pay now\" twice"), &["S".into(), "F".into()]).unwrap();
        index_doc(&conn, "acc", "INBOX", 4, &doc("Project plan", "bob@x.test", "Draft budget attached"), none).unwrap();
        index_doc(&conn, "other", "INBOX", 5, &doc("Café elsewhere", "z@x.test", ""), none).unwrap();
        (tmp, conn)
    }

    #[test]
    fn index_doc_round_trips_through_search_without_a_vault() {
        let (tmp, conn) = seed();
        assert!(!tmp.path().join("search_index").exists(), "no vault directory is made");
        // Accents fold both ways, inside words too.
        assert_eq!(uids(&conn, q("cafe")), vec![1]);
        assert_eq!(uids(&conn, q("CAFÉ")), vec![1]);
        assert_eq!(uids(&conn, q("afé")), vec![1]);
        // CJK: a short word through msg_cjk, a longer phrase through the trigram table.
        assert_eq!(uids(&conn, q("会議")), vec![2]);
        assert_eq!(uids(&conn, q("東京で会議")), vec![2]);
        // Quotes in the query are text, never FTS syntax.
        assert_eq!(uids(&conn, q("\"pay now\"")), vec![3]);
        assert_eq!(uids(&conn, q("\"invoice")), vec![3], "an unbalanced quote");
        assert_eq!(uids(&conn, q("pay\" OR \"x")), Vec::<u32>::new());
        // Boolean groups.
        assert_eq!(uids(&conn, q("invoice || budget")), vec![3, 4]);
        assert_eq!(uids(&conn, q("project && budget")), vec![4]);
        assert_eq!(uids(&conn, q("project && invoice")), Vec::<u32>::new());
        // Sender and account scope.
        assert_eq!(uids(&conn, SearchRequest { sender: Some("acme".into()), ..q("") }), vec![3]);
        let both = SearchRequest { account_ids: vec!["acc".into(), "other".into()], ..q("café") };
        assert_eq!(uids(&conn, both), vec![1, 5]);
    }

    #[test]
    fn a_folder_scope_matches_the_key_the_writer_was_given() {
        let (_tmp, conn) = seed();
        let in_box = |b: &str| SearchRequest { mailboxes: Some(vec![b.into()]), ..q("") };
        assert_eq!(uids(&conn, in_box("[Gmail]/All Mail")), vec![3]);
        assert_eq!(uids(&conn, in_box("INBOX")), vec![1, 2, 4]);
        let hit = search(&conn, &in_box("[Gmail]/All Mail")).unwrap().hits.remove(0);
        assert_eq!(hit.vault_dir, vault_dir_name("[Gmail]/All Mail"));
        assert_eq!(hit.filename, "");
        assert_eq!(hit.snippet.as_deref(), Some("He said \"pay now\" twice"));
    }

    #[test]
    fn flags_are_stored_as_letters_the_view_filters_read() {
        let (_tmp, conn) = seed();
        assert_eq!(uids(&conn, SearchRequest { unread: Some(true), ..q("") }), vec![1, 4]);
        assert_eq!(uids(&conn, SearchRequest { starred: Some(true), ..q("") }), vec![3]);
        set_flags(&conn, "acc", "INBOX", 4, &["flagged".into()]).unwrap();
        assert_eq!(uids(&conn, SearchRequest { starred: Some(true), ..q("") }), vec![3, 4]);
        // A flag change keeps the body terms.
        assert_eq!(uids(&conn, q("budget")), vec![4]);
    }

    #[test]
    fn indexing_again_replaces_the_row_and_its_terms() {
        let (_tmp, conn) = seed();
        index_doc(&conn, "acc", "INBOX", 4, &doc("Holiday rota", "bob@x.test", "Who covers December"), &[]).unwrap();
        assert_eq!(uids(&conn, q("budget")), Vec::<u32>::new());
        assert_eq!(uids(&conn, q("rota")), vec![4]);
        let rows: i64 = conn.query_row("SELECT count(*) FROM messages WHERE uid = 4", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1);
        // A doc with no date is dated now, never 1970.
        index_doc(&conn, "acc", "INBOX", 6, &IndexDoc { date_utc: None, ..doc("Undated", "u@x.test", "") }, &[]).unwrap();
        let date: i64 = conn.query_row("SELECT date_utc FROM messages WHERE uid = 6", [], |r| r.get(0)).unwrap();
        assert!(date > 1_700_000_000, "{date}");
    }

    fn fts_rows(conn: &Connection) -> (i64, i64) {
        let fts: i64 = conn.query_row("SELECT count(*) FROM msg_fts WHERE msg_fts MATCH '\"budget\"'", [], |r| r.get(0)).unwrap();
        let cjk: i64 = conn.query_row("SELECT count(*) FROM msg_cjk WHERE msg_cjk MATCH '\"会\"'", [], |r| r.get(0)).unwrap();
        (fts, cjk)
    }

    #[test]
    fn forget_removes_the_message_and_its_terms() {
        let (_tmp, conn) = seed();
        let row: i64 = conn.query_row("SELECT id FROM messages WHERE uid = 4", [], |r| r.get(0)).unwrap();
        conn.execute("INSERT INTO attachments (message_row, part_index, filename, size, state) VALUES (?1, 0, 'budget.xlsx', 1, 'done')", [row]).unwrap();
        assert_eq!(fts_rows(&conn).0, 1);
        forget(&conn, "acc", "INBOX", 4).unwrap();
        assert_eq!(uids(&conn, q("budget")), Vec::<u32>::new());
        assert_eq!(fts_rows(&conn).0, 0, "the FTS terms go with the row");
        let attachments: i64 = conn.query_row("SELECT count(*) FROM attachments", [], |r| r.get(0)).unwrap();
        assert_eq!(attachments, 0);
        assert_eq!(uids(&conn, q("")), vec![1, 2, 3], "the rest stay");
        forget(&conn, "acc", "INBOX", 4).unwrap();
    }

    #[test]
    fn forget_folder_removes_that_folder_only() {
        let (_tmp, conn) = seed();
        assert_eq!(fts_rows(&conn), (1, 1));
        forget_folder(&conn, "acc", "INBOX").unwrap();
        assert_eq!(uids(&conn, q("")), vec![3]);
        assert_eq!(fts_rows(&conn), (0, 0), "trigram and CJK terms of the folder are gone");
        assert_eq!(uids(&conn, SearchRequest { account_id: "other".into(), ..q("café") }), vec![5], "another account's INBOX stays");
        assert_eq!(uids(&conn, q("invoice")), vec![3]);
    }

    #[test]
    fn writes_nest_inside_a_chunk_transaction_the_caller_holds() {
        let conn = Connection::open_in_memory().unwrap();
        crate::search_index::db::ensure_schema(&conn).unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        for uid in 1..=3 {
            index_doc(&tx, "acc", "INBOX", uid, &doc(&format!("Chunk row {uid}"), "c@x.test", "chunked body"), &[]).unwrap();
        }
        forget(&tx, "acc", "INBOX", 2).unwrap();
        tx.commit().unwrap();
        assert_eq!(uids(&conn, q("chunked")), vec![1, 3]);
    }
}
