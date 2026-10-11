//! Person CRUD over `person`, `source_record`, `person_link`, `record_address`.
//! Every mutation journals its inverse (see `journal`).
use crate::people::journal::{self, Step};
use crate::people::message_addr::normalize;
use crate::people::model::*;
use crate::people::vcard::VCard;
use rusqlite::{params, params_from_iter, types::Value as Sql, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;

fn err(e: rusqlite::Error) -> String { e.to_string() }

#[derive(Debug, Clone, Default)]
pub struct NewPerson {
    pub display_name: String,
    pub emails: Vec<String>,
    pub phones: Vec<String>,
    pub org: String,
    pub notes: String,
    pub source_kind: String,
    pub raw: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Patch {
    pub display_name: Option<String>,
    pub notes: Option<String>,
    pub org: Option<String>,
    pub vip: Option<bool>,
    pub pinned: Option<bool>,
    pub blocked: Option<bool>,
    pub emails: Option<Vec<String>>,
    pub phones: Option<Vec<String>>,
}

fn clean_emails(v: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for e in v {
        if let Some(a) = normalize(e) {
            if !out.contains(&a) { out.push(a); }
        }
    }
    out
}

fn load_records(conn: &Connection, person_id: &str) -> Result<Vec<RecordRow>, String> {
    let mut out = Vec::new();
    for id in journal::snapshot_links(conn, person_id)? {
        if let Some(r) = journal::snapshot_record(conn, &id)? { out.push(r); }
    }
    Ok(out)
}

fn like(q: &str) -> String {
    format!("%{}%", q.to_lowercase().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))
}

/// Recompute `search_text` (name, addresses, org) from the person's records.
pub fn reindex(conn: &Connection, id: &str) -> Result<(), String> {
    let Some(p) = journal::snapshot_person(conn, id)? else { return Ok(()) };
    let mut text = p.display_name.to_lowercase();
    for r in load_records(conn, id)? {
        for c in VCard::parse_all(&r.raw) {
            for (a, _) in c.emails() {
                text.push(' ');
                text.push_str(&a);
            }
            text.push(' ');
            text.push_str(&c.org().to_lowercase());
        }
    }
    conn.execute("UPDATE person SET search_text=?2 WHERE id=?1", params![id, text]).map_err(err)?;
    Ok(())
}

/// Create a person and its record WITHOUT journaling. Returns the new id and
/// the steps that undo it, so a bulk import can write one grouped entry per
/// chunk. Runs inside the caller's transaction. The record always holds a real
/// card (`BEGIN:VCARD`..`END:VCARD`), also for a person with no email, because
/// `vcard::addresses` reads the record text.
pub fn create_person_steps(conn: &Connection, np: &NewPerson) -> Result<(String, Vec<Step>), String> {
    let person_id = new_id();
    let record_id = new_id();
    let now = now_ms();
    let kind = if np.source_kind.is_empty() { "local".to_string() } else { np.source_kind.clone() };
    let emails = clean_emails(&np.emails);
    let raw = np.raw.clone().unwrap_or_else(|| {
        let mut card = VCard::new_card(&np.display_name, &emails, &np.phones, &np.org);
        card.set_note(&np.notes);
        card.to_text()
    });
    let first = VCard::parse_all(&raw).into_iter().next().unwrap_or_default();
    let name = if np.display_name.trim().is_empty() { first.fn_name() } else { np.display_name.trim().to_string() };
    let notes = if np.notes.is_empty() { first.note() } else { np.notes.clone() };
    journal::apply(
        conn,
        &Step::PutRecord(RecordRow {
            id: record_id.clone(),
            account_id: String::new(),
            source_kind: kind,
            remote_id: String::new(),
            etag: String::new(),
            raw,
            tombstone: false,
            fetched_ms: now,
        }),
    )?;
    journal::apply(
        conn,
        &Step::PutPerson(PersonRow {
            id: person_id.clone(),
            display_name: name,
            notes,
            vip: first.flag("X-MAILVAULT-VIP"),
            pinned: first.flag("X-MAILVAULT-PINNED"),
            blocked: first.flag("X-MAILVAULT-BLOCKED"),
            search_text: String::new(),
            created_ms: now,
            updated_ms: now,
            deleted_ms: None,
        }),
    )?;
    journal::apply(conn, &Step::SetLink { record_id: record_id.clone(), person_id: Some(person_id.clone()) })?;
    reindex(conn, &person_id)?;
    Ok((person_id.clone(), vec![Step::DropRecord { id: record_id }, Step::DropPerson { id: person_id }]))
}

pub fn create_person(conn: &Connection, np: &NewPerson) -> Result<String, String> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    let (person_id, inverse) = create_person_steps(&tx, np)?;
    journal::record(&tx, "create", &json!({"id": person_id}), &inverse)?;
    tx.commit().map_err(err)?;
    Ok(person_id)
}

pub fn get_card(conn: &Connection, id: &str) -> Result<Option<Card>, String> {
    let Some(p) = journal::snapshot_person(conn, id)? else { return Ok(None) };
    if p.deleted_ms.is_some() { return Ok(None); }
    let mut card = Card {
        id: p.id.clone(),
        display_name: p.display_name.clone(),
        emails: vec![],
        phones: vec![],
        org: String::new(),
        notes: p.notes.clone(),
        vip: p.vip,
        pinned: p.pinned,
        blocked: p.blocked,
        record_ids: vec![],
        source_kinds: vec![],
    };
    for r in load_records(conn, id)? {
        card.record_ids.push(r.id.clone());
        if !card.source_kinds.contains(&r.source_kind) { card.source_kinds.push(r.source_kind.clone()); }
        for c in VCard::parse_all(&r.raw) {
            for (a, label) in c.emails() {
                if !card.emails.iter().any(|e| e.address == a) {
                    card.emails.push(CardEmail { address: a, label, record_id: r.id.clone() });
                }
            }
            for (n, label) in c.phones() {
                if !card.phones.iter().any(|x| x.number == n) {
                    card.phones.push(CardPhone { number: n, label, record_id: r.id.clone() });
                }
            }
            if card.org.is_empty() { card.org = c.org(); }
        }
    }
    // a contact with no name is shown by its first address, else its first number; the row stays blank
    if card.display_name.trim().is_empty() {
        card.display_name = card.emails.first().map(|e| e.address.clone()).or_else(|| card.phones.first().map(|p| p.number.clone())).unwrap_or_default();
    }
    Ok(Some(card))
}

pub fn card_addresses(card: &Card) -> Vec<String> { card.emails.iter().map(|e| e.address.clone()).collect() }

pub fn find_person_by_address(conn: &Connection, address: &str) -> Result<Option<String>, String> {
    let Some(a) = normalize(address) else { return Ok(None) };
    conn.query_row(
        "SELECT p.id FROM record_address ra JOIN person_link l ON l.record_id=ra.record_id \
         JOIN person p ON p.id=l.person_id WHERE ra.address=?1 AND p.deleted_ms IS NULL LIMIT 1",
        [a],
        |r| r.get(0),
    )
    .optional()
    .map_err(err)
}

pub fn update_person(conn: &Connection, id: &str, p: &Patch) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    let before = journal::snapshot_person(&tx, id)?.ok_or("E_NOT_FOUND: person")?;
    let mut inverse = vec![Step::PutPerson(before.clone())];
    let mut after = before.clone();
    if let Some(v) = &p.display_name { after.display_name = v.trim().to_string(); }
    if let Some(v) = &p.notes { after.notes = v.clone(); }
    if let Some(v) = p.vip { after.vip = v; }
    if let Some(v) = p.pinned { after.pinned = v; }
    if let Some(v) = p.blocked { after.blocked = v; }
    after.updated_ms = now_ms();

    if p.emails.is_some() || p.phones.is_some() || p.org.is_some() || p.display_name.is_some() {
        let records = load_records(&tx, id)?;
        let editable = records.iter().find(|r| r.source_kind == "local" || r.source_kind == "import").cloned();
        let mut rec = match editable {
            Some(r) => {
                inverse.push(Step::PutRecord(r.clone()));
                r
            }
            None => {
                let r = RecordRow {
                    id: new_id(),
                    account_id: String::new(),
                    source_kind: "local".into(),
                    remote_id: String::new(),
                    etag: String::new(),
                    raw: VCard::new_card(&after.display_name, &[], &[], "").to_text(),
                    tombstone: false,
                    fetched_ms: now_ms(),
                };
                inverse.push(Step::DropRecord { id: r.id.clone() });
                r
            }
        };
        let mut cards = VCard::parse_all(&rec.raw);
        let mut card = if cards.is_empty() { VCard::new_card(&after.display_name, &[], &[], "") } else { cards.remove(0) };
        if let Some(e) = &p.emails { card.set_emails(&clean_emails(e)); }
        if let Some(ph) = &p.phones { card.set_phones(ph); }
        if let Some(o) = &p.org { card.set_org(o); }
        if p.display_name.is_some() { card.set_fn(&after.display_name); }
        rec.raw = card.to_text();
        journal::apply(&tx, &Step::PutRecord(rec.clone()))?;
        if !records.iter().any(|r| r.id == rec.id) {
            journal::apply(&tx, &Step::SetLink { record_id: rec.id.clone(), person_id: Some(id.to_string()) })?;
        }
        // the card is the union of the records: a value removed here must go from the other editable ones too
        if p.emails.is_some() || p.phones.is_some() {
            let want_emails = p.emails.as_deref().map(clean_emails);
            for other in records.iter().filter(|r| r.id != rec.id && (r.source_kind == "local" || r.source_kind == "import")) {
                let Some(mut oc) = VCard::parse_all(&other.raw).into_iter().next() else { continue };
                if let Some(w) = &want_emails {
                    let keep: Vec<String> = oc.emails().into_iter().map(|(a, _)| a).filter(|a| w.contains(a)).collect();
                    oc.set_emails(&keep);
                }
                if let Some(w) = &p.phones {
                    let keep: Vec<String> = oc.phones().into_iter().map(|(n, _)| n).filter(|n| w.iter().any(|x| x.trim() == n)).collect();
                    oc.set_phones(&keep);
                }
                let raw = oc.to_text();
                if raw != other.raw {
                    inverse.push(Step::PutRecord(other.clone()));
                    journal::apply(&tx, &Step::PutRecord(RecordRow { raw, ..other.clone() }))?;
                }
            }
        }
    }
    journal::apply(&tx, &Step::PutPerson(after))?;
    reindex(&tx, id)?;
    // reindex changed search_text after the snapshot; the inverse PutPerson restores the old row whole
    journal::record(&tx, "edit", &json!({"id": id}), &inverse)?;
    tx.commit().map_err(err)
}

pub fn delete_person(conn: &Connection, id: &str) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    let before = journal::snapshot_person(&tx, id)?.ok_or("E_NOT_FOUND: person")?;
    let mut gone = before.clone();
    gone.deleted_ms = Some(now_ms());
    journal::apply(&tx, &Step::PutPerson(gone))?;
    journal::record(&tx, "delete", &json!({"id": id, "name": before.display_name}), &[Step::PutPerson(before)])?;
    tx.commit().map_err(err)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub display_name: String,
    pub primary_email: String,
    pub vip: bool,
    pub pinned: bool,
    pub blocked: bool,
    pub address_count: usize,
    pub total: Option<u64>,
    pub last_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sort {
    Name,
    Total,
    Last,
}

impl Sort {
    pub fn parse(s: &str) -> Sort {
        match s {
            "total" => Sort::Total,
            "last" => Sort::Last,
            _ => Sort::Name,
        }
    }
}

pub fn list(conn: &Connection, query: Option<&str>, vip_only: bool, sort: Sort, limit: usize, offset: usize) -> Result<(Vec<Summary>, usize), String> {
    let totals = if sort == Sort::Name { None } else { Some(crate::people::correspondence::totals_by_address(conn)?) };
    list_with_totals(conn, query, vip_only, sort, limit, offset, totals.as_ref())
}

pub fn list_with_totals(
    conn: &Connection,
    query: Option<&str>,
    vip_only: bool,
    sort: Sort,
    limit: usize,
    offset: usize,
    totals: Option<&std::collections::HashMap<String, (u64, i64)>>,
) -> Result<(Vec<Summary>, usize), String> {
    let mut args: Vec<Sql> = Vec::new();
    let mut wher = String::from("p.deleted_ms IS NULL");
    if vip_only { wher.push_str(" AND p.vip=1"); }
    if let Some(q) = query.map(str::trim).filter(|q| !q.is_empty()) {
        args.push(Sql::Text(like(q)));
        wher.push_str(&format!(" AND p.search_text LIKE ?{} ESCAPE '\\'", args.len()));
    }
    let total: i64 = conn
        .query_row(&format!("SELECT count(*) FROM person p WHERE {wher}"), params_from_iter(args.clone()), |r| r.get(0))
        .map_err(err)?;
    // by name the page is cut in SQL and only its people get addresses; total/last sorts need every person's numbers first
    let by_name = sort == Sort::Name;
    let mut paging = String::new();
    if by_name {
        args.push(Sql::Integer(limit.min(i64::MAX as usize) as i64));
        args.push(Sql::Integer(offset.min(i64::MAX as usize) as i64));
        paging = format!(" LIMIT ?{} OFFSET ?{}", args.len() - 1, args.len());
    }
    let mut stmt = conn
        .prepare(&format!(
            "SELECT p.id, p.display_name, p.vip, p.pinned, p.blocked FROM person p WHERE {wher} \
             ORDER BY p.pinned DESC, lower(p.display_name), p.id{paging}"
        ))
        .map_err(err)?;
    let base = stmt
        .query_map(params_from_iter(args), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, bool>(2)?, r.get::<_, bool>(3)?, r.get::<_, bool>(4)?))
        })
        .map_err(err)?
        .collect::<Result<Vec<(String, String, bool, bool, bool)>, _>>()
        .map_err(err)?;
    let mut addr_stmt = conn
        .prepare(
            "SELECT DISTINCT ra.address FROM person_link l JOIN record_address ra ON ra.record_id=l.record_id \
             WHERE l.person_id=?1 ORDER BY ra.address",
        )
        .map_err(err)?;
    let mut items: Vec<Summary> = Vec::with_capacity(base.len());
    for (id, mut name, vip, pinned, blocked) in base {
        if name.trim().is_empty() {
            name = get_card(conn, &id)?.map(|c| c.display_name).unwrap_or(name);
        }
        let addrs: Vec<String> = addr_stmt
            .query_map([&id], |r| r.get::<_, String>(0))
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?;
        let (mut tot, mut last) = (None, None);
        if let Some(t) = totals {
            let (mut n, mut l) = (0u64, i64::MIN);
            for a in &addrs {
                if let Some((c, ms)) = t.get(a) {
                    n += c;
                    l = l.max(*ms);
                }
            }
            tot = Some(n);
            last = (l != i64::MIN).then_some(l);
        }
        items.push(Summary {
            id,
            display_name: name,
            primary_email: addrs.first().cloned().unwrap_or_default(),
            vip,
            pinned,
            blocked,
            address_count: addrs.len(),
            total: tot,
            last_ms: last,
        });
    }
    match sort {
        Sort::Name => {}
        Sort::Total => items.sort_by(|a, b| b.total.cmp(&a.total).then_with(|| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()))),
        Sort::Last => items.sort_by(|a, b| b.last_ms.cmp(&a.last_ms).then_with(|| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()))),
    }
    let page = if by_name { items } else { items.into_iter().skip(offset).take(limit).collect() };
    Ok((page, total as usize))
}

/// Every live person id in list order (pinned first, then name), one cheap
/// query, so a caller can page the expensive per-person work itself.
pub fn all_ids(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT id FROM person WHERE deleted_ms IS NULL ORDER BY pinned DESC, lower(display_name), id")
        .map_err(err)?;
    let ids = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(err)?.collect::<Result<_, _>>().map_err(err)?;
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custody::db;

    fn conn() -> (tempfile::TempDir, Connection) {
        let t = tempfile::tempdir().unwrap();
        let c = db::open(t.path()).unwrap();
        (t, c)
    }
    fn np(name: &str, emails: &[&str]) -> NewPerson {
        NewPerson { display_name: name.into(), emails: emails.iter().map(|e| e.to_string()).collect(), ..Default::default() }
    }

    #[test]
    fn create_then_get_resolves_a_card() {
        let (_t, c) = conn();
        let id = create_person(
            &c,
            &NewPerson { phones: vec!["+1 555 0100".into()], org: "Acme".into(), notes: "n".into(), ..np("Alice A", &["Alice@X.io", "al@work.io"]) },
        )
        .unwrap();
        let card = get_card(&c, &id).unwrap().unwrap();
        assert_eq!(card.display_name, "Alice A");
        assert_eq!(card.emails.iter().map(|e| e.address.as_str()).collect::<Vec<_>>(), ["alice@x.io", "al@work.io"]);
        assert_eq!(card.phones[0].number, "+1 555 0100");
        assert_eq!((card.org.as_str(), card.notes.as_str()), ("Acme", "n"));
        assert_eq!(card.source_kinds, ["local"]);
    }

    #[test]
    fn a_manually_created_contacts_notes_are_stored_in_the_card_text_too() {
        let (_t, c) = conn();
        let id = create_person(&c, &NewPerson { notes: "met at the fair".into(), ..np("Nora", &["n@x.io"]) }).unwrap();
        let rec: String = c.query_row("SELECT raw FROM source_record", [], |r| r.get(0)).unwrap();
        assert!(rec.contains("NOTE:met at the fair"), "{rec}");
        assert_eq!(get_card(&c, &id).unwrap().unwrap().notes, "met at the fair");
    }

    #[test]
    fn flags_in_an_imported_card_become_person_flags() {
        let (_t, c) = conn();
        let raw = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Flagged\r\nEMAIL:f@x.io\r\nX-MAILVAULT-VIP:1\r\nX-MAILVAULT-PINNED:1\r\nEND:VCARD\r\n";
        let id = create_person(&c, &NewPerson { raw: Some(raw.into()), source_kind: "import".into(), ..Default::default() }).unwrap();
        let card = get_card(&c, &id).unwrap().unwrap();
        assert!(card.vip && card.pinned && !card.blocked);
    }

    #[test]
    fn a_person_with_no_email_works_end_to_end() {
        let (_t, c) = conn();
        let id = create_person(&c, &NewPerson { phones: vec!["555".into()], ..np("Phone Only", &[]) }).unwrap();
        let card = get_card(&c, &id).unwrap().unwrap();
        assert!(card.emails.is_empty());
        update_person(&c, &id, &Patch { notes: Some("hello".into()), ..Default::default() }).unwrap();
        let (items, total) = list(&c, None, false, Sort::Name, 50, 0).unwrap();
        assert_eq!(total, 1);
        assert_eq!(items[0].primary_email, "");
    }

    #[test]
    fn a_contact_with_no_name_is_stored_blank_and_shown_by_its_first_email_or_else_its_first_phone() {
        let (_t, c) = conn();
        let by_mail = create_person(&c, &np("", &["Al@X.io", "b@x.io"])).unwrap();
        let by_phone = create_person(&c, &NewPerson { phones: vec!["+1 555 0100".into(), "222".into()], ..np(" ", &[]) }).unwrap();
        crate::people::vcard::import(&c, "BEGIN:VCARD\nEMAIL:z@x.io\nEND:VCARD\nBEGIN:VCARD\nTEL:+1 555 0300\nEND:VCARD\n").unwrap();
        let named: i64 = c.query_row("SELECT count(*) FROM person WHERE trim(display_name)<>''", [], |r| r.get(0)).unwrap();
        assert_eq!(named, 0, "the fallback is shown, never stored");
        assert_eq!(get_card(&c, &by_mail).unwrap().unwrap().display_name, "al@x.io");
        assert_eq!(get_card(&c, &by_phone).unwrap().unwrap().display_name, "+1 555 0100");
        let mut names: Vec<String> = list(&c, None, false, Sort::Name, 10, 0).unwrap().0.into_iter().map(|s| s.display_name).collect();
        names.sort();
        assert_eq!(names, ["+1 555 0100", "+1 555 0300", "al@x.io", "z@x.io"], "no blank row in the list");
        assert!(crate::people::vcard::export(&c, None).unwrap().contains("FN:al@x.io"), "a card needs an FN");
    }

    #[test]
    fn a_phone_only_person_still_stores_a_real_card() {
        let (_t, c) = conn();
        create_person(&c, &NewPerson { phones: vec!["555".into()], ..np("Phone Only", &[]) }).unwrap();
        let rec: String = c.query_row("SELECT raw FROM source_record", [], |r| r.get(0)).unwrap();
        assert!(rec.starts_with("BEGIN:VCARD") && rec.trim_end().ends_with("END:VCARD"), "{rec}");
    }

    #[test]
    fn address_spellings_resolve_to_one_person() {
        let (_t, c) = conn();
        let id = create_person(&c, &np("Al", &["  <Al@X.IO> "])).unwrap();
        assert_eq!(find_person_by_address(&c, "al@x.io").unwrap(), Some(id));
    }

    #[test]
    fn update_edits_the_record_keeps_unknown_lines_and_is_undoable() {
        let (_t, c) = conn();
        let raw = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Al\r\nEMAIL;TYPE=WORK:al@x.io\r\nX-CUSTOM:keep-me\r\nEND:VCARD\r\n";
        let id = create_person(&c, &NewPerson { raw: Some(raw.into()), source_kind: "import".into(), ..np("Al", &[]) }).unwrap();
        update_person(&c, &id, &Patch { emails: Some(vec!["al@x.io".into(), "al2@x.io".into()]), vip: Some(true), ..Default::default() }).unwrap();
        let rec: String = c.query_row("SELECT raw FROM source_record", [], |r| r.get(0)).unwrap();
        assert!(rec.contains("X-CUSTOM:keep-me"));
        assert!(rec.contains("TYPE=WORK"), "the label of an unchanged address survives");
        let card = get_card(&c, &id).unwrap().unwrap();
        assert!(card.vip);
        assert_eq!(card.emails.len(), 2);
        crate::people::journal::undo_last(&c).unwrap();
        let card = get_card(&c, &id).unwrap().unwrap();
        assert!(!card.vip);
        assert_eq!(card.emails.len(), 1);
    }

    #[test]
    fn removing_a_merged_address_removes_it_from_every_editable_record_and_undo_restores_it() {
        let (_t, c) = conn();
        let a = create_person(&c, &np("A", &["a@x.io"])).unwrap();
        let b = create_person(&c, &np("B", &["b@x.io"])).unwrap();
        crate::people::merge::merge(&c, &[a.clone(), b], &a).unwrap();
        for keep in ["a@x.io", "b@x.io"] {
            update_person(&c, &a, &Patch { emails: Some(vec![keep.into()]), ..Default::default() }).unwrap();
            let card = get_card(&c, &a).unwrap().unwrap();
            assert_eq!(card.emails.iter().map(|e| e.address.as_str()).collect::<Vec<_>>(), [keep]);
            let gone = if keep == "a@x.io" { "b@x.io" } else { "a@x.io" };
            assert_eq!(find_person_by_address(&c, gone).unwrap(), None, "record_address no longer holds {gone}");
            crate::people::journal::undo_last(&c).unwrap();
            assert_eq!(get_card(&c, &a).unwrap().unwrap().emails.len(), 2);
        }
    }

    #[test]
    fn removing_a_merged_phone_removes_it_from_every_editable_record() {
        let (_t, c) = conn();
        let a = create_person(&c, &NewPerson { phones: vec!["111".into()], ..np("A", &["a@x.io"]) }).unwrap();
        let b = create_person(&c, &NewPerson { phones: vec!["222".into()], ..np("B", &["b@x.io"]) }).unwrap();
        crate::people::merge::merge(&c, &[a.clone(), b], &a).unwrap();
        update_person(&c, &a, &Patch { phones: Some(vec!["222".into()]), ..Default::default() }).unwrap();
        let card = get_card(&c, &a).unwrap().unwrap();
        assert_eq!(card.phones.iter().map(|p| p.number.as_str()).collect::<Vec<_>>(), ["222"]);
    }

    #[test]
    fn delete_is_soft_hides_from_list_and_undo_restores() {
        let (_t, c) = conn();
        let id = create_person(&c, &np("Al", &["al@x.io"])).unwrap();
        delete_person(&c, &id).unwrap();
        assert!(get_card(&c, &id).unwrap().is_none());
        assert_eq!(find_person_by_address(&c, "al@x.io").unwrap(), None);
        assert_eq!(list(&c, None, false, Sort::Name, 10, 0).unwrap().1, 0);
        crate::people::journal::undo_last(&c).unwrap();
        assert!(get_card(&c, &id).unwrap().is_some());
    }

    #[test]
    fn list_searches_name_and_address_sorts_and_pages() {
        let (_t, c) = conn();
        create_person(&c, &np("Zed", &["z@x.io"])).unwrap();
        create_person(&c, &np("Amy", &["amy@corp.io"])).unwrap();
        create_person(&c, &np("Bob", &["bob@corp.io"])).unwrap();
        let (names, total) = list(&c, None, false, Sort::Name, 2, 0).unwrap();
        assert_eq!((total, names.iter().map(|s| s.display_name.as_str()).collect::<Vec<_>>()), (3, vec!["Amy", "Bob"]));
        let (page2, _) = list(&c, None, false, Sort::Name, 2, 2).unwrap();
        assert_eq!(page2[0].display_name, "Zed");
        let (hit, _) = list(&c, Some("corp"), false, Sort::Name, 10, 0).unwrap();
        assert_eq!(hit.len(), 2);
    }

    #[test]
    fn a_name_sorted_page_is_cut_in_sql_and_keeps_the_total_and_everyones_addresses() {
        let (_t, c) = conn();
        for (n, e) in [("Cy", "c@x.io"), ("Al", "a@x.io"), ("Bo", "b@x.io")] {
            create_person(&c, &np(n, &[e])).unwrap();
        }
        let (page, total) = list(&c, None, false, Sort::Name, 1, 1).unwrap();
        assert_eq!((total, page.len(), page[0].display_name.as_str(), page[0].primary_email.as_str()), (3, 1, "Bo", "b@x.io"));
        assert!(list(&c, None, false, Sort::Name, 10, 5).unwrap().0.is_empty());
        assert_eq!(list(&c, None, false, Sort::Name, usize::MAX, 0).unwrap().0.len(), 3);
    }

    #[test]
    fn search_text_treats_percent_literally() {
        let (_t, c) = conn();
        create_person(&c, &np("Fifty%", &["f@x.io"])).unwrap();
        create_person(&c, &np("Other", &["o@x.io"])).unwrap();
        assert_eq!(list(&c, Some("%"), false, Sort::Name, 10, 0).unwrap().1, 1);
    }
}
