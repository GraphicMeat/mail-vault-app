//! Local merge and split. Neither touches a provider: a merge re-points record
//! links to the kept person and hides the others; the journal holds the inverse.
use crate::people::journal::{self, Step};
use crate::people::model::*;
use crate::people::store::{get_card, reindex};
use rusqlite::Connection;
use serde_json::json;

fn err(e: rusqlite::Error) -> String { e.to_string() }

fn validate(conn: &Connection, ids: &[String], keep: &str) -> Result<(), String> {
    if ids.len() < 2 { return Err("E_INVALID: a merge needs at least two contacts".into()); }
    if !ids.iter().any(|i| i == keep) { return Err("E_INVALID: keep must be one of the merged contacts".into()); }
    for id in ids {
        if get_card(conn, id)?.is_none() { return Err(format!("E_NOT_FOUND: contact {id}")); }
    }
    Ok(())
}

fn combined(conn: &Connection, ids: &[String], keep: &str) -> Result<(PersonRow, Vec<(String, String)>), String> {
    let mut keeper = journal::snapshot_person(conn, keep)?.ok_or("E_NOT_FOUND: keeper")?;
    let mut moves: Vec<(String, String)> = Vec::new();
    for id in ids.iter().filter(|i| i.as_str() != keep) {
        let other = journal::snapshot_person(conn, id)?.ok_or("E_NOT_FOUND: contact")?;
        keeper.vip |= other.vip;
        keeper.pinned |= other.pinned;
        keeper.blocked |= other.blocked;
        if keeper.display_name.trim().is_empty() { keeper.display_name = other.display_name.clone(); }
        let extra = other.notes.trim();
        if !extra.is_empty() && !keeper.notes.contains(extra) {
            if !keeper.notes.trim().is_empty() { keeper.notes.push_str("\n\n"); }
            keeper.notes.push_str(extra);
        }
        for rid in journal::snapshot_links(conn, id)? { moves.push((rid, id.clone())); }
    }
    Ok((keeper, moves))
}

/// The card the merge would produce. Writes nothing.
pub fn preview(conn: &Connection, ids: &[String], keep: &str) -> Result<Card, String> {
    validate(conn, ids, keep)?;
    let tx = conn.unchecked_transaction().map_err(err)?;
    let card = apply_merge(&tx, ids, keep, false)?;
    // dropping the transaction without commit rolls everything back
    drop(tx);
    Ok(card)
}

fn apply_merge(conn: &Connection, ids: &[String], keep: &str, journal_it: bool) -> Result<Card, String> {
    let (keeper_after, moves) = combined(conn, ids, keep)?;
    let keeper_before = journal::snapshot_person(conn, keep)?.ok_or("E_NOT_FOUND: keeper")?;
    let mut inverse: Vec<Step> = vec![Step::PutPerson(keeper_before)];
    for id in ids.iter().filter(|i| i.as_str() != keep) {
        inverse.push(Step::PutPerson(journal::snapshot_person(conn, id)?.ok_or("E_NOT_FOUND: contact")?));
    }
    for (rid, from) in &moves { inverse.push(Step::SetLink { record_id: rid.clone(), person_id: Some(from.clone()) }); }
    for (rid, _) in &moves { journal::apply(conn, &Step::SetLink { record_id: rid.clone(), person_id: Some(keep.to_string()) })?; }
    for id in ids.iter().filter(|i| i.as_str() != keep) {
        let mut gone = journal::snapshot_person(conn, id)?.ok_or("E_NOT_FOUND: contact")?;
        gone.deleted_ms = Some(now_ms());
        journal::apply(conn, &Step::PutPerson(gone))?;
    }
    let mut k = keeper_after;
    k.updated_ms = now_ms();
    journal::apply(conn, &Step::PutPerson(k))?;
    reindex(conn, keep)?;
    if journal_it {
        journal::record(conn, "merge", &json!({"keep": keep, "ids": ids}), &inverse)?;
    }
    get_card(conn, keep)?.ok_or_else(|| "E_NOT_FOUND: merged contact".to_string())
}

pub fn merge(conn: &Connection, ids: &[String], keep: &str) -> Result<Card, String> {
    validate(conn, ids, keep)?;
    let tx = conn.unchecked_transaction().map_err(err)?;
    let card = apply_merge(&tx, ids, keep, true)?;
    tx.commit().map_err(err)?;
    Ok(card)
}

/// Move the chosen records of a person onto a new person. Returns the new id.
pub fn split(conn: &Connection, person_id: &str, record_ids: &[String]) -> Result<String, String> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    let linked = journal::snapshot_links(&tx, person_id)?;
    if record_ids.is_empty() || record_ids.iter().any(|r| !linked.contains(r)) {
        return Err("E_INVALID: records must belong to the contact".into());
    }
    if record_ids.len() == linked.len() { return Err("E_INVALID: a contact must keep at least one record".into()); }
    let created = new_id();
    let first = journal::snapshot_record(&tx, &record_ids[0])?.ok_or("E_NOT_FOUND: record")?;
    let name = crate::people::vcard::VCard::parse_all(&first.raw).first().map(|c| c.fn_name()).unwrap_or_default();
    let now = now_ms();
    journal::apply(
        &tx,
        &Step::PutPerson(PersonRow {
            id: created.clone(),
            display_name: name,
            notes: String::new(),
            vip: false,
            pinned: false,
            blocked: false,
            search_text: String::new(),
            created_ms: now,
            updated_ms: now,
            deleted_ms: None,
        }),
    )?;
    let mut inverse = vec![Step::DropPerson { id: created.clone() }];
    for r in record_ids {
        inverse.push(Step::SetLink { record_id: r.clone(), person_id: Some(person_id.to_string()) });
        journal::apply(&tx, &Step::SetLink { record_id: r.clone(), person_id: Some(created.clone()) })?;
    }
    // the old person's search_text is about to shrink: snapshot it BEFORE the
    // reindex so undo restores the row whole
    inverse.push(Step::PutPerson(journal::snapshot_person(&tx, person_id)?.ok_or("E_NOT_FOUND: person")?));
    reindex(&tx, &created)?;
    reindex(&tx, person_id)?;
    journal::record(&tx, "split", &json!({"id": person_id, "newId": created}), &inverse)?;
    tx.commit().map_err(err)?;
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custody::db;
    use crate::people::journal;
    use crate::people::store::{create_person, get_card, list, update_person, NewPerson, Patch, Sort};

    fn conn() -> (tempfile::TempDir, Connection) {
        let t = tempfile::tempdir().unwrap();
        let c = db::open(t.path()).unwrap();
        (t, c)
    }
    fn mk(c: &Connection, name: &str, e: &[&str]) -> String {
        create_person(c, &NewPerson { display_name: name.into(), emails: e.iter().map(|x| x.to_string()).collect(), ..Default::default() }).unwrap()
    }

    #[test]
    fn merge_unions_addresses_ors_flags_and_hides_the_others() {
        let (_t, c) = conn();
        let a = mk(&c, "Al", &["a@x.io"]);
        let b = mk(&c, "Alan", &["b@x.io"]);
        update_person(&c, &b, &Patch { vip: Some(true), notes: Some("from b".into()), ..Default::default() }).unwrap();
        let merged = merge(&c, &[a.clone(), b.clone()], &a).unwrap();
        assert_eq!(merged.display_name, "Al");
        assert_eq!(merged.emails.len(), 2);
        assert!(merged.vip);
        assert!(merged.notes.contains("from b"));
        assert!(get_card(&c, &b).unwrap().is_none());
    }

    #[test]
    fn a_nameless_keeper_takes_the_name_of_the_person_merged_into_it() {
        let (_t, c) = conn();
        let a = mk(&c, "", &["a@x.io"]);
        let b = mk(&c, "Al Smith", &["b@x.io"]);
        assert_eq!(merge(&c, &[a.clone(), b], &a).unwrap().display_name, "Al Smith");
    }

    #[test]
    fn preview_writes_nothing() {
        let (_t, c) = conn();
        let a = mk(&c, "Al", &["a@x.io"]);
        let b = mk(&c, "Bo", &["b@x.io"]);
        let before: i64 = c.query_row("SELECT count(*) FROM person_journal", [], |r| r.get(0)).unwrap();
        let card = preview(&c, &[a.clone(), b.clone()], &a).unwrap();
        assert_eq!(card.emails.len(), 2);
        let after: i64 = c.query_row("SELECT count(*) FROM person_journal", [], |r| r.get(0)).unwrap();
        assert_eq!(before, after);
        assert!(get_card(&c, &b).unwrap().is_some());
    }

    #[test]
    fn undo_restores_the_two_people_exactly() {
        let (_t, c) = conn();
        let a = mk(&c, "Al", &["a@x.io"]);
        let b = mk(&c, "Bo", &["b@x.io"]);
        merge(&c, &[a.clone(), b.clone()], &a).unwrap();
        journal::undo_last(&c).unwrap();
        assert_eq!(get_card(&c, &a).unwrap().unwrap().emails.len(), 1);
        assert_eq!(get_card(&c, &b).unwrap().unwrap().emails.len(), 1);
    }

    #[test]
    fn three_way_merge_with_overlapping_flags_then_undo() {
        let (_t, c) = conn();
        let a = mk(&c, "A", &["a@x.io"]);
        let b = mk(&c, "B", &["b@x.io"]);
        let d = mk(&c, "D", &["d@x.io"]);
        update_person(&c, &b, &Patch { pinned: Some(true), ..Default::default() }).unwrap();
        update_person(&c, &d, &Patch { vip: Some(true), blocked: Some(true), ..Default::default() }).unwrap();
        let m = merge(&c, &[a.clone(), b.clone(), d.clone()], &a).unwrap();
        assert!(m.pinned && m.vip && m.blocked);
        assert_eq!(m.emails.len(), 3);
        journal::undo_last(&c).unwrap();
        assert!(!get_card(&c, &a).unwrap().unwrap().vip);
        assert!(get_card(&c, &d).unwrap().unwrap().blocked);
    }

    #[test]
    fn undoing_a_merge_after_a_later_edit_undoes_the_edit_first() {
        let (_t, c) = conn();
        let a = mk(&c, "A", &["a@x.io"]);
        let b = mk(&c, "B", &["b@x.io"]);
        merge(&c, &[a.clone(), b.clone()], &a).unwrap();
        update_person(&c, &a, &Patch { notes: Some("later".into()), ..Default::default() }).unwrap();
        assert_eq!(journal::undo_last(&c).unwrap().unwrap().op, "edit");
        assert!(get_card(&c, &b).unwrap().is_none(), "the merge is still in force");
        assert_eq!(journal::undo_last(&c).unwrap().unwrap().op, "merge");
        assert!(get_card(&c, &b).unwrap().is_some());
    }

    #[test]
    fn merge_rejects_bad_input() {
        let (_t, c) = conn();
        let a = mk(&c, "A", &["a@x.io"]);
        assert!(merge(&c, &[a.clone()], &a).is_err(), "needs two");
        let b = mk(&c, "B", &["b@x.io"]);
        assert!(merge(&c, &[a.clone(), b], "nope").is_err(), "keep must be one of ids");
    }

    #[test]
    fn split_moves_chosen_records_to_a_new_person_and_undoes() {
        let (_t, c) = conn();
        let a = mk(&c, "A", &["a@x.io"]);
        let b = mk(&c, "B", &["b@x.io"]);
        let merged = merge(&c, &[a.clone(), b], &a).unwrap();
        let moving = merged.emails.iter().find(|e| e.address == "b@x.io").unwrap().record_id.clone();
        let new_id = split(&c, &a, &[moving]).unwrap();
        assert_eq!(get_card(&c, &new_id).unwrap().unwrap().emails[0].address, "b@x.io");
        assert_eq!(get_card(&c, &a).unwrap().unwrap().emails.len(), 1);
        journal::undo_last(&c).unwrap();
        assert!(get_card(&c, &new_id).unwrap().is_none());
        assert_eq!(get_card(&c, &a).unwrap().unwrap().emails.len(), 2);
        let (hit, _) = list(&c, Some("b@x.io"), false, Sort::Name, 10, 0).unwrap();
        assert_eq!(hit.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), [a.as_str()], "search text restored whole");
    }
}
