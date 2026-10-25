//! Small versioned metadata plus exclusive native physical-location claims.
//! Bodies/attachment bytes remain in the vault, never in this database.
use super::Connection;
use crate::drafts::{Location, Record};
use rusqlite::{params, OptionalExtension};

pub fn load(c: &Connection, id: &str) -> Result<Option<Record>, String> {
    let raw: Option<String> = c
        .query_row(
            "SELECT state_json FROM local_drafts WHERE draft_id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    raw.map(|raw| {
        let row: Record = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if row.version != 1 || row.draft_id != id {
            return Err("unsupported draft metadata".into());
        }
        Ok(row)
    })
    .transpose()
}
pub fn all(c: &Connection) -> Result<Vec<Record>, String> {
    let mut q = c
        .prepare("SELECT draft_id FROM local_drafts ORDER BY draft_id")
        .map_err(|e| e.to_string())?;
    let ids = q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    ids.iter()
        .map(|id| load(c, id)?.ok_or_else(|| "draft disappeared".into()))
        .collect()
}
pub fn owner(c: &Connection, l: &Location) -> Result<Option<String>, String> {
    c.query_row(
        "SELECT draft_id FROM local_draft_locations WHERE account_id=?1 AND mailbox=?2 AND uid=?3",
        params![l.account_id, l.mailbox, l.uid],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}
pub fn save(c: &Connection, record: &Record) -> Result<(), String> {
    write(c, record, None)
}

/// Conditional native intent/publication transition, including its location
/// claims, in one app.db transaction. A stale attempt cannot replace it.
pub fn save_if(c: &Connection, expected: &Record, next: &Record) -> Result<(), String> {
    if expected.draft_id != next.draft_id { return Err("draft identity changed".into()); }
    write(c, next, Some(expected))
}

fn write(c: &Connection, r: &Record, expected: Option<&Record>) -> Result<(), String> {
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    let encoded = serde_json::to_string(r).map_err(|e| e.to_string())?;
    if let Some(expected) = expected {
        let old = serde_json::to_string(expected).map_err(|e| e.to_string())?;
        let changed = tx.execute(
            "UPDATE local_drafts SET state_json=?2 WHERE draft_id=?1 AND state_json=?3",
            params![r.draft_id, encoded, old],
        ).map_err(|e| e.to_string())?;
        if changed != 1 { return Err("draft intent changed".into()); }
    } else {
        tx.execute(
            "INSERT INTO local_drafts(draft_id,state_json) VALUES (?1,?2)
             ON CONFLICT(draft_id) DO UPDATE SET state_json=excluded.state_json",
            params![r.draft_id, encoded],
        ).map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM local_draft_locations WHERE draft_id=?1", [&r.draft_id])
        .map_err(|e| e.to_string())?;
    for copy in r.current.iter().chain(r.pending.iter().flat_map(|p| [&p.copy, &p.prepared])).chain(&r.cleanup) {
        let location = copy.location();
        tx.execute(
            "INSERT INTO local_draft_locations(account_id,mailbox,uid,draft_id) VALUES (?1,?2,?3,?4)
             ON CONFLICT(account_id,mailbox,uid) DO UPDATE SET draft_id=excluded.draft_id
             WHERE draft_id=excluded.draft_id",
            params![location.account_id, location.mailbox, location.uid, r.draft_id],
        ).map_err(|e| e.to_string())?;
        if owner(&tx, &location)?.as_deref() != Some(&r.draft_id) {
            return Err("draft location already owned".into());
        }
    }
    tx.commit().map_err(|e| e.to_string())
}
