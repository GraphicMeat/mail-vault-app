//! Append-only operation journal. Every mutation records the primitive steps
//! that undo it. Undo only ever reverses the newest non-undone entry, so an
//! inverse never runs against state a later operation changed.
use crate::people::model::{now_ms, PersonRow, RecordRow};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

fn err(e: rusqlite::Error) -> String { e.to_string() }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "step", rename_all = "snake_case")]
pub enum Step {
    PutPerson(PersonRow),
    DropPerson { id: String },
    PutRecord(RecordRow),
    DropRecord { id: String },
    SetLink { record_id: String, person_id: Option<String> },
}

pub fn apply(conn: &Connection, step: &Step) -> Result<(), String> {
    match step {
        Step::PutPerson(p) => {
            conn.execute(
                "INSERT OR REPLACE INTO person(id,display_name,notes,vip,pinned,blocked,search_text,created_ms,updated_ms,deleted_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![p.id, p.display_name, p.notes, p.vip, p.pinned, p.blocked, p.search_text, p.created_ms, p.updated_ms, p.deleted_ms],
            )
            .map_err(err)?;
        }
        Step::DropPerson { id } => {
            conn.execute("DELETE FROM person WHERE id=?1", [id]).map_err(err)?;
        }
        Step::PutRecord(r) => {
            conn.execute(
                "INSERT OR REPLACE INTO source_record(id,account_id,source_kind,remote_id,etag,raw,tombstone,fetched_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![r.id, r.account_id, r.source_kind, r.remote_id, r.etag, r.raw, r.tombstone, r.fetched_ms],
            )
            .map_err(err)?;
            conn.execute("DELETE FROM record_address WHERE record_id=?1", [&r.id]).map_err(err)?;
            for a in crate::people::vcard::addresses(&r.raw) {
                conn.execute("INSERT OR IGNORE INTO record_address(record_id,address) VALUES (?1,?2)", params![r.id, a]).map_err(err)?;
            }
        }
        Step::DropRecord { id } => {
            conn.execute("DELETE FROM record_address WHERE record_id=?1", [id]).map_err(err)?;
            conn.execute("DELETE FROM person_link WHERE record_id=?1", [id]).map_err(err)?;
            conn.execute("DELETE FROM source_record WHERE id=?1", [id]).map_err(err)?;
        }
        Step::SetLink { record_id, person_id } => match person_id {
            Some(p) => {
                conn.execute("INSERT OR REPLACE INTO person_link(record_id,person_id) VALUES (?1,?2)", params![record_id, p]).map_err(err)?;
            }
            None => {
                conn.execute("DELETE FROM person_link WHERE record_id=?1", [record_id]).map_err(err)?;
            }
        },
    }
    Ok(())
}

pub fn record(conn: &Connection, op: &str, summary: &Value, inverse: &[Step]) -> Result<i64, String> {
    record_in(conn, op, summary, inverse, "")
}

/// `grp` ties several entries into one undoable action (a chunked import). An
/// empty group means the entry stands alone.
pub fn record_in(conn: &Connection, op: &str, summary: &Value, inverse: &[Step], grp: &str) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO person_journal(ts_ms,op,summary,inverse,undone,grp) VALUES (?1,?2,?3,?4,0,?5)",
        params![now_ms(), op, summary.to_string(), serde_json::to_string(inverse).map_err(|e| e.to_string())?, grp],
    )
    .map_err(err)?;
    Ok(conn.last_insert_rowid())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalRow {
    pub id: i64,
    pub ts_ms: i64,
    pub op: String,
    pub summary: Value,
    pub undone: bool,
    /// How many journal entries this line stands for (a group is one line).
    pub count: usize,
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<(JournalRow, String)> {
    let summary: String = r.get(3)?;
    Ok((
        JournalRow {
            id: r.get(0)?,
            ts_ms: r.get(1)?,
            op: r.get(2)?,
            summary: serde_json::from_str(&summary).unwrap_or(Value::Null),
            undone: r.get::<_, i64>(4)? != 0,
            count: 1,
        },
        r.get(5)?,
    ))
}

/// Newest first; entries of one group collapse into a single line.
pub fn recent(conn: &Connection, limit: usize) -> Result<Vec<JournalRow>, String> {
    let mut stmt = conn
        .prepare("SELECT id,ts_ms,op,summary,undone,grp FROM person_journal ORDER BY id DESC LIMIT ?1")
        .map_err(err)?;
    let rows = stmt.query_map([limit as i64 * 20], row).map_err(err)?;
    let mut out: Vec<(JournalRow, String)> = Vec::new();
    for r in rows {
        let (entry, grp) = r.map_err(err)?;
        match out.last_mut() {
            Some((prev, g)) if !grp.is_empty() && *g == grp => prev.count += 1,
            _ => out.push((entry, grp)),
        }
    }
    out.truncate(limit);
    Ok(out.into_iter().map(|(e, _)| e).collect())
}

pub fn undo_last(conn: &Connection) -> Result<Option<JournalRow>, String> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    let found: Option<(JournalRow, String)> = tx
        .query_row(
            "SELECT id,ts_ms,op,summary,undone,grp FROM person_journal WHERE undone=0 ORDER BY id DESC LIMIT 1",
            [],
            row,
        )
        .optional()
        .map_err(err)?;
    let Some((mut entry, grp)) = found else { return Ok(None) };
    // the newest entry, plus every other open entry of its group, newest first
    let ids: Vec<(i64, String)> = if grp.is_empty() {
        let inv: String = tx.query_row("SELECT inverse FROM person_journal WHERE id=?1", [entry.id], |r| r.get(0)).map_err(err)?;
        vec![(entry.id, inv)]
    } else {
        let mut stmt = tx.prepare("SELECT id, inverse FROM person_journal WHERE grp=?1 AND undone=0 ORDER BY id DESC").map_err(err)?;
        let rows = stmt.query_map([&grp], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)?
    };
    entry.count = ids.len();
    for (id, inverse) in &ids {
        let steps: Vec<Step> = serde_json::from_str(inverse).map_err(|e| format!("journal entry {id} unreadable: {e}"))?;
        for s in &steps { apply(&tx, s)?; }
        tx.execute("UPDATE person_journal SET undone=1 WHERE id=?1", [id]).map_err(err)?;
    }
    tx.commit().map_err(err)?;
    Ok(Some(JournalRow { undone: true, ..entry }))
}

pub fn snapshot_person(conn: &Connection, id: &str) -> Result<Option<PersonRow>, String> {
    conn.query_row(
        "SELECT id,display_name,notes,vip,pinned,blocked,search_text,created_ms,updated_ms,deleted_ms FROM person WHERE id=?1",
        [id],
        |r| Ok(PersonRow {
            id: r.get(0)?, display_name: r.get(1)?, notes: r.get(2)?, vip: r.get(3)?, pinned: r.get(4)?, blocked: r.get(5)?,
            search_text: r.get(6)?, created_ms: r.get(7)?, updated_ms: r.get(8)?, deleted_ms: r.get(9)?,
        }),
    )
    .optional()
    .map_err(err)
}

pub fn snapshot_record(conn: &Connection, id: &str) -> Result<Option<RecordRow>, String> {
    conn.query_row(
        "SELECT id,account_id,source_kind,remote_id,etag,raw,tombstone,fetched_ms FROM source_record WHERE id=?1",
        [id],
        |r| Ok(RecordRow {
            id: r.get(0)?, account_id: r.get(1)?, source_kind: r.get(2)?, remote_id: r.get(3)?, etag: r.get(4)?,
            raw: r.get(5)?, tombstone: r.get(6)?, fetched_ms: r.get(7)?,
        }),
    )
    .optional()
    .map_err(err)
}

pub fn snapshot_links(conn: &Connection, person_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare("SELECT record_id FROM person_link WHERE person_id=?1 ORDER BY record_id").map_err(err)?;
    let rows = stmt.query_map([person_id], |r| r.get::<_, String>(0)).map_err(err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custody::db;
    use crate::people::model::*;
    use serde_json::json;

    fn conn() -> (tempfile::TempDir, Connection) {
        let t = tempfile::tempdir().unwrap();
        let c = db::open(t.path()).unwrap();
        (t, c)
    }
    fn person(id: &str, name: &str) -> PersonRow {
        PersonRow { id: id.into(), display_name: name.into(), notes: String::new(), vip: false, pinned: false, blocked: false,
            search_text: name.to_lowercase(), created_ms: 1, updated_ms: 1, deleted_ms: None }
    }
    fn record(id: &str, raw: &str) -> RecordRow {
        RecordRow { id: id.into(), account_id: String::new(), source_kind: "local".into(), remote_id: String::new(),
            etag: String::new(), raw: raw.into(), tombstone: false, fetched_ms: 1 }
    }

    #[test]
    fn put_record_rebuilds_its_addresses_and_drop_removes_everything() {
        let (_t, c) = conn();
        apply(&c, &Step::PutRecord(record("r1", "BEGIN:VCARD\r\nEMAIL:Al@X.io\r\nEND:VCARD"))).unwrap();
        apply(&c, &Step::SetLink { record_id: "r1".into(), person_id: Some("p1".into()) }).unwrap();
        let a: String = c.query_row("SELECT address FROM record_address WHERE record_id='r1'", [], |r| r.get(0)).unwrap();
        assert_eq!(a, "al@x.io");
        apply(&c, &Step::DropRecord { id: "r1".into() }).unwrap();
        for t in ["source_record", "record_address", "person_link"] {
            let n: i64 = c.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0)).unwrap();
            assert_eq!(n, 0, "{t}");
        }
    }

    #[test]
    fn undo_runs_the_inverse_steps_of_the_latest_entry_only() {
        let (_t, c) = conn();
        apply(&c, &Step::PutPerson(person("p1", "Old"))).unwrap();
        record_op(&c, "edit", &json!({"id":"p1"}), &[Step::PutPerson(person("p1", "Old"))]);
        apply(&c, &Step::PutPerson(person("p1", "New"))).unwrap();
        let undone = undo_last(&c).unwrap().unwrap();
        assert_eq!(undone.op, "edit");
        let name: String = c.query_row("SELECT display_name FROM person WHERE id='p1'", [], |r| r.get(0)).unwrap();
        assert_eq!(name, "Old");
        assert!(undo_last(&c).unwrap().is_none(), "already undone, nothing newer");
    }

    #[test]
    fn undo_with_nothing_in_the_journal_is_none() {
        let (_t, c) = conn();
        assert!(undo_last(&c).unwrap().is_none());
    }

    #[test]
    fn one_undo_reverses_a_whole_group_and_recent_shows_it_as_one_entry() {
        let (_t, c) = conn();
        record_in(&c, "import", &json!({"n": 1}), &[Step::DropPerson { id: "p1".into() }], "g1").unwrap();
        record_in(&c, "import", &json!({"n": 1}), &[Step::DropPerson { id: "p2".into() }], "g1").unwrap();
        record_in(&c, "import", &json!({"n": 1}), &[Step::DropPerson { id: "p3".into() }], "g1").unwrap();
        for id in ["p1", "p2", "p3"] { apply(&c, &Step::PutPerson(person(id, id))).unwrap(); }
        let r = recent(&c, 10).unwrap();
        assert_eq!(r.len(), 1, "a group is one line in Activity");
        assert_eq!(r[0].count, 3);
        undo_last(&c).unwrap();
        let n: i64 = c.query_row("SELECT count(*) FROM person", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "all three chunks undone together");
        assert!(undo_last(&c).unwrap().is_none());
    }

    #[test]
    fn an_ungrouped_entry_after_a_group_is_undone_alone() {
        let (_t, c) = conn();
        record_in(&c, "import", &json!({}), &[], "g1").unwrap();
        super::record(&c, "edit", &json!({}), &[]).unwrap();
        assert_eq!(undo_last(&c).unwrap().unwrap().op, "edit");
        assert_eq!(undo_last(&c).unwrap().unwrap().op, "import");
    }

    #[test]
    fn recent_lists_newest_first_and_flags_undone() {
        let (_t, c) = conn();
        record_op(&c, "a", &json!({}), &[]);
        record_op(&c, "b", &json!({}), &[]);
        undo_last(&c).unwrap();
        let r = recent(&c, 10).unwrap();
        assert_eq!((r[0].op.as_str(), r[0].undone), ("b", true));
        assert_eq!((r[1].op.as_str(), r[1].undone), ("a", false));
    }

    fn record_op(c: &Connection, op: &str, s: &serde_json::Value, inv: &[Step]) { super::record(c, op, s, inv).unwrap(); }
}
